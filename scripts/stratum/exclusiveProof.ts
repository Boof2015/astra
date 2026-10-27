/** Real Stratum -> main/preload PCM bridge, silently. No Electron or device. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { NativeStratumRegistry } from '../../src/main/nativeStratum.ts'
import { createNativeRemoteSourceResolver } from '../../src/preload/nativeRemoteSource.ts'
import { startNativeStratumDecoder } from '../../src/preload/nativeStratumDecoder.ts'
import { StratumProofSession } from '../../src/main/services/stratumProofSession.ts'
import { stratumQualitySelection } from '../../src/main/services/stratumProofConfig.ts'
import { RemoteAudioCache } from '../../src/main/services/remoteAudioCache.ts'
import { StratumAudioCache } from '../../src/main/services/stratumAudioCache.ts'
import { decodeStratumProofSegment } from '../../src/main/services/stratumProofPlayback.ts'
import type { NativeProgressiveInput } from '../../src/types/nativeProgressive.ts'
import type { NativeRemoteRequest, NativeRemoteSource } from '../../src/types/nativeRemoteSource.ts'
import type { StreamingQualityRequest } from '../../src/types/streamingQuality.ts'

const binary = process.env.ASTRA_STRATUM_SIDECAR
assert.ok(binary, 'Set ASTRA_STRATUM_SIDECAR to the sidecar-access binary.')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < end, 'fixture timed out'); await delay(5) }
}
function fixture(rate: number, seconds = 9, bits = 16) {
  const stride = 2 * bits / 8
  const frames = rate * seconds + 317, wav = Buffer.alloc(44 + frames * stride), pcm = Buffer.alloc(frames * 8)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * stride, 28); wav.writeUInt16LE(stride, 32); wav.writeUInt16LE(bits, 34)
  wav.write('data', 36); wav.writeUInt32LE(frames * stride, 40)
  const extrema = [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1, -1, 0, 1, -309, 419, 43]
  for (let i = 0; i < frames * 2; i++) {
    const value = i < extrema.length ? extrema[i]
      : Math.round(2 ** (bits - 3) * Math.sin(Math.floor(i / 2) * 2 * Math.PI * (i % 2 ? 911 : 317) / rate))
    wav.writeIntLE(value, 44 + i * bits / 8, bits / 8); pcm.writeInt32LE(value * 2 ** (32 - bits), i * 4)
  }
  return { rate, frames, wav, pcm, bits }
}

async function directBytes(source: NativeRemoteSource, sampleBytes: number) {
  const info = source.pcm!.info, stride = info.channels * sampleBytes
  let published = info.startFrame, ended = false
  const chunks: Buffer[] = []
  const input = { status: () => ({ sessionId: 1, state: 'open', sampleRate: info.sampleRate, startFrame: info.startFrame,
    publishedFrame: published, bytesPerFrame: stride }), append: (data: Uint8Array) => {
    chunks.push(Buffer.from(data)); published += data.length / stride; return data.length / stride
  }, cancel() {}, finish: () => { ended = true; return true } } as NativeProgressiveInput
  const decoder = startNativeStratumDecoder(source, input, new AbortController().signal, error => assert.fail(error.message))
  await decoder.done
  assert.equal(ended, true)
  return Buffer.concat(chunks)
}

test('native Stratum preserves processed and bit-perfect PCM, seeks, cache and audible quality', { timeout: 80000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-stratum-exclusive-'))
  const tracks = new Map([['r44100', fixture(44100)], ['r48000', fixture(48000)], ['r96000', fixture(96000)],
    ['r44100_24', fixture(44100, 9, 24)], ['r48000_24', fixture(48000, 9, 24)], ['r96000_24', fixture(96000, 9, 24)]])
  let deny = false, reads = 0, failed = 0, id = 1, holds = 0
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const values = new URLSearchParams(body)
    const reply = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': value })) }
    if (values.get('t') !== createHash('md5').update('fixture-password' + values.get('s')).digest('hex')) {
      reply({ status: 'failed', error: { code: 40 } }); return
    }
    if (req.url?.endsWith('ping.view')) { reply({ status: 'ok' }); return }
    if (deny) { reply({ status: 'failed', error: { code: 50 } }); return }
    const source = tracks.get(values.get('id') ?? '')
    if (!source) { reply({ status: 'failed', error: { code: 70 } }); return }
    if (req.url?.endsWith('getSong.view')) { reply({ status: 'ok', song: { id: values.get('id'), size: source.wav.length } }); return }
    if (req.headers.range) { res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes 0-0/${source.wav.length}` }); res.end(source.wav.subarray(0, 1)) }
    else { reads++; res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': source.wav.length }); res.end(source.wav) }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const config = join(directory, 'sidecar.json')
  await writeFile(config, JSON.stringify({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, run_seconds: 85 }), { mode: 0o600 })
  const child = spawn(binary!, ['--config', config], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(child, 'close'), deadline = setTimeout(() => child.kill('SIGKILL'), 83000)
  let line = ''; child.stdout.on('data', chunk => { line += chunk })
  t.after(async () => {
    clearTimeout(deadline); child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await closed; clearTimeout(force)
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  await until(() => line.includes('\n'))
  const owner = new StratumProofSession(JSON.parse(line.split('\n')[0]).listen, async () => ({ username: 'listener', password: 'fixture-password' }))
  const cache = new RemoteAudioCache(join(directory, 'cache'), 64 * 1024 * 1024)
  const audio = new StratumAudioCache(cache, { decode: (segment, signal) => decodeStratumProofSegment(ffmpeg, segment, signal),
    scan: async () => { throw new Error('Analysis deliberately disabled in this PCM fixture.') } })
  const registry = new NativeStratumRegistry({
    ffmpeg: async () => ffmpeg, allocateId: () => id++, started() {}, failed() { failed++ },
    holdArtwork: () => { holds++; let held = true; return () => { if (held) { held = false; holds-- } } },
    route: async (path, quality) => {
      const selected = stratumQualitySelection(quality ?? 'original')
      if (!selected || !path.startsWith('subsonic://1/')) return null
      const track = path.slice('subsonic://1/'.length)
      return { ...selected, key: 'exclusive-fixture', track, connection: owner,
        cache: { owner: audio, options: { scope: 'exclusive-fixture', track, revision: '1', profile: selected.mode ?? selected.quality } } }
    }
  })
  const request = { policy: 'processed', slot: 'current', startTimeSeconds: 0 } as const
  const invoke = async (channel: string, ...args: unknown[]) => {
    const key = args[0] as string
    switch (channel) {
      case 'native-stratum:open': return registry.open(1, key, args[1] as string, args[2] as StreamingQualityRequest, args[3] as NativeRemoteRequest)
      case 'native-stratum:read': return registry.read(1, key)
      case 'native-stratum:progress': return registry.progress(1, key, args[1] as number, args[2] as number, args[3] as number)
      case 'native-stratum:finished': return registry.finished(1, key)
      case 'native-stratum:activate': return registry.activate(1, key)
      case 'native-stratum:release': return registry.release(1, key)
      default: throw new Error(`Unexpected conventional request ${channel}`)
    }
  }
  const resolve = createNativeRemoteSourceResolver(invoke)
  const stop = new AbortController()
  try {
    for (const [track, reference] of tracks) {
      for (const quality of ['original', 64, 128, 192, 256, 320] as const) {
        const source = await resolve(`subsonic://1/${track}`, stop.signal, quality, request)
        const info = source.pcm!.info
        assert.equal(info.sampleRate, reference.rate)
        assert.equal(source.quality?.transport, 'stratum')
        const chunks: Buffer[] = []
        let published = info.startFrame, retained = published, state: 'open' | 'ended' | 'cancelled' = 'open'
        const capacity = reference.rate
        const input = { status: () => ({ sessionId: 1, sampleRate: info.sampleRate, startFrame: info.startFrame,
          publishedFrame: published, retainedFrame: retained, bytesPerFrame: 8, capacityFrames: capacity, state }),
          append: (bytes: Uint8Array) => { const frames = Math.min(bytes.length / 8, capacity - (published - retained))
            chunks.push(Buffer.from(bytes.subarray(0, frames * 8))); published += frames; return frames },
          cancel: () => { state = 'cancelled' }, finish: () => { state = 'ended'; return true }
        } as NativeProgressiveInput
        const decoder = startNativeStratumDecoder(source, input, stop.signal, error => assert.fail(error.message))
        await decoder.ready
        await delay(30)
        assert.ok(published - retained <= capacity)
        assert.ok(decoder.pendingBytes <= 65536)
        const drain = setInterval(() => { retained = published }, 2)
        try { await decoder.done } finally { clearInterval(drain) }
        const result = Buffer.concat(chunks)
        assert.equal(result.length, reference.pcm.length, `${track} ${quality} changed frame count`)
        if (quality === 'original') assert.deepEqual(result, reference.pcm)
        const progress = await source.progress(0, published / reference.rate, 48000)
        assert.equal(progress.complete, true)
        assert.equal(registry.diagnostics(1, info.sessionId)?.state, 'complete')
        assert.equal(registry.diagnostics(1, info.sessionId)?.sourceRate, reference.rate)
        assert.equal(registry.diagnostics(1, info.sessionId)?.outputRate, 48000)
        await source.pcm!.close()
      }
      const before = reads, seek = 1.234567
      const source = await resolve(`subsonic://1/${track}`, stop.signal, 'original', { ...request, startTimeSeconds: seek })
      const chunks: Buffer[] = []
      for (let data; (data = await source.pcm!.read()) !== null;) chunks.push(Buffer.from(data))
      assert.deepEqual(Buffer.concat(chunks), reference.pcm.subarray(Math.floor(seek * reference.rate) * 8))
      assert.equal(reads, before, 'a retained seek must not reacquire the source')
      await source.pcm!.close()
      for (const sampleBytes of [reference.bits / 8, 4]) {
        for (const start of [0, 1.234567]) {
          const direct = await resolve(`subsonic://1/${track}`, stop.signal, 64,
            { ...request, policy: 'direct', startTimeSeconds: start })
          assert.equal(direct.pcm!.info.bitDepth, reference.bits)
          assert.equal(direct.quality?.requested, 'original', 'saved Fixed must not change direct Stratum')
          assert.equal(direct.quality?.mode, undefined)
          const data = await directBytes(direct, sampleBytes)
          const referenceBytes = sampleBytes === 4 ? reference.pcm : reference.wav.subarray(44)
          assert.deepEqual(data, referenceBytes.subarray(Math.floor(start * reference.rate) * 2 * sampleBytes))
          await direct.pcm!.close()
        }
      }
    }
    // Cache a deliberately mixed track and check the readout follows consumption,
    // even when later qualities have already been decoded and sent to native.
    await cache.clearUnused()
    const retained = await audio.open(owner, { scope: 'exclusive-fixture', track: 'r48000', revision: '1', profile: 'automatic' }, stop.signal)
    await retained.segment(0, 'lossless', stop.signal)
    await retained.segment(192000, 'opus-128', stop.signal)
    await retained.segment(384000, 'lossless', stop.signal)
    retained.dispose(); await retained.releaseRemote()
    const mixed = await resolve('subsonic://1/r48000', stop.signal, 'automatic', request)
    while (await mixed.pcm!.read() !== null) {}
    assert.equal((await mixed.progress(0, 9)).quality?.requested, 'original')
    assert.equal((await mixed.progress(4.25, 9)).quality?.requested, 128)
    assert.equal((await mixed.progress(8.25, 9)).quality?.requested, 'original')
    mixed.pcm!.activate()
    await mixed.pcm!.close()
    for (const quality of ['automatic', 'automatic-original', 128] as const) {
      const direct = await resolve('subsonic://1/r48000', stop.signal, quality, { ...request, policy: 'direct' })
      assert.deepEqual(await directBytes(direct, 2), tracks.get('r48000')!.wav.subarray(44))
      assert.ok(registry.diagnostics(1, direct.pcm!.info.sessionId)!.segments.every(segment => segment.quality === 'lossless'))
      await direct.pcm!.close()
    }
    // Opus cached during Automatic must never rescue an unavailable Original in
    // Bit-perfect. Existing processed Automatic can still play that same cache.
    await cache.clearUnused()
    const lossy = await audio.open(owner, { scope: 'exclusive-fixture', track: 'r48000', revision: '1', profile: 'automatic' }, stop.signal)
    for (const frame of [0, 192000, 384000]) await lossy.segment(frame, 'opus-64', stop.signal)
    lossy.dispose(); await lossy.releaseRemote()
    // A missing source/refused account falls back before native receives PCM.
    deny = true
    assert.equal(await registry.open(1, 'denied', 'subsonic://1/missing', 'original', request), null)
    assert.equal(failed, 1)
    assert.deepEqual(await registry.open(1, 'direct', 'subsonic://1/r48000', 'automatic', { ...request, policy: 'direct' }), { fallbackQuality: 'original' })
    const offline = await resolve('subsonic://1/r48000', stop.signal, 'automatic', request)
    await directBytes(offline, 4)
    assert.equal(offline.quality?.requested, 64)
    await offline.pcm!.close()
    assert.equal(holds, 0)
    t.diagnostic('Exact 16/24-bit 44.1/48/96 kHz Original PCM and seeks, native integer packing, no cached Opus substitution in direct mode; processed Opus 64/128/192/256/320, bounded delivery, audible markers and startup fallback passed. No device opened.')
  } finally { stop.abort(); await registry.close(); await audio.close(); await cache.close(); await owner.close() }
})
