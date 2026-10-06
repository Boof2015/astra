import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { AutomaticStreamingQuality } from './automaticStreamingQuality.ts'
import { AutomaticQualityPreparations } from './automaticQualityPreparations.ts'
import { acquireQualityAudio } from './streamingQualityAcquisition.ts'
import { RemoteAudioCache } from './remoteAudioCache.ts'
import { createSubsonicAudioSource } from './subsonicAudioSource.ts'
import { createJellyfinAudioSource } from './jellyfinAudioSource.ts'
import type { StreamQualityTarget } from '../../types/streamingQuality.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string
const run = promisify(execFile)

test('automatic modes prepare real reduced audio under throttling without releasing current playback, for both providers', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-auto-audio-'))
  const original = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=sample_rate=48000:duration=40:seed=1',
    '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 })
  const variants = new Map<StreamQualityTarget, Buffer>([['original', original]])
  for (const target of [64, 128, 192, 256, 320] as const) variants.set(target, execFileSync(ffmpeg, [
    '-v', 'error', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', `${target}k`, '-f', 'mp3', 'pipe:1'
  ], { input: original, maxBuffer: 3 * 1024 * 1024 }))
  const urls: URL[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    urls.push(url)
    const target = url.searchParams.get('format') === 'raw' || url.searchParams.get('static') === 'true' ? 'original'
      : Number(url.searchParams.get('maxBitRate') ?? Number(url.searchParams.get('AudioBitRate')) / 1000) as StreamQualityTarget
    const bytes = variants.get(target)
    if (!bytes) { response.writeHead(400).end(); return }
    response.writeHead(200, { 'Content-Type': target === 'original' ? 'audio/wav' : 'audio/mpeg',
      ...(target === 'original' ? { 'Content-Length': String(bytes.length) } : {}) })
    let offset = 0
    // Accelerated clock: approximately 300 kbps of measured delivery at 50x time.
    const timer = setInterval(() => {
      const end = Math.min(bytes.length, offset + 37_500)
      response.write(bytes.subarray(offset, end)); offset = end
      if (offset === bytes.length) { clearInterval(timer); response.end() }
    }, 20)
    response.once('close', () => clearInterval(timer))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const connection = { baseUrl: `http://127.0.0.1:${address.port}`, username: 'fixture', password: 'fixture' }
  const cache = new RemoteAudioCache(directory)
  const preparations: AutomaticQualityPreparations[] = []
  t.after(async () => {
    for (const preparation of preparations) preparation.releaseOwner(1)
    await cache.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  for (const provider of ['subsonic', 'jellyfin'] as const) {
    const policy = new AutomaticStreamingQuality(() => performance.now() * 50)
    const mode = provider === 'subsonic' ? 'automatic' : 'automatic-original'
    const make = (quality: StreamQualityTarget) => {
      const options = { sourceId: 1, trackId: 'song', revision: '1', connection, quality }
      return provider === 'subsonic' ? createSubsonicAudioSource(options)
        : createJellyfinAudioSource({ ...options, authenticate: async () => ({ accessToken: 'fixture', userId: 'fixture' }) })
    }
    const base = { cache, policy, key: provider, originalKbps: 1536, track: { codec: 'pcm_s16le', bitrate: 1536 }, make }
    const current = await acquireQualityAudio({ ...base, selected: mode, signal: new AbortController().signal })
    assert.equal(current.quality?.requested, 'original')
    let target: StreamQualityTarget | null = null
    const started = performance.now()
    while (target === null && performance.now() - started < 2000) {
      await delay(25)
      const progress = current.progress()
      target = policy.recommend(provider, mode, { ...progress, originalKbps: 1536, current: 'original',
        duration: 40, position: 0, bufferedSeconds: progress.loadedBytes * 8 / 1_536_000 })
    }
    assert.equal(typeof target, 'number', 'sustained constrained delivery should prepare a reduction')
    assert.ok(Number(target) <= 256)
    const before = current.progress().loadedBytes
    const preparation = new AutomaticQualityPreparations({
      acquire: (_path, signal, selected) => acquireQualityAudio({ ...base, selected, signal }),
      prime: async (lease, position, signal) => {
        const result = await run(ffmpeg, ['-v', 'error', '-ss', String(position), '-i', lease.url,
          '-map', '0:a:0', '-t', '8', '-vn', '-progress', 'pipe:1', '-f', 'null', '-'], { signal, timeout: 10_000 })
        const times = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]))
        assert.ok(times.some(time => time >= 7_500_000), 'real decoder verifies eight seconds at the requested position')
      }
    })
    preparations.push(preparation)
    const request = { mode, target: target! } as const
    await preparation.prepare(1, provider, `${provider}://1/song`, request, 2, { mode, target: 'original' })
    assert.ok(current.progress().loadedBytes >= before, 'original remains leased and continues fetching while the candidate is prepared')
    const range = await fetch(current.url, { headers: { Range: 'bytes=0-31' } })
    assert.equal((await range.arrayBuffer()).byteLength, 32)
    const switched = await acquireQualityAudio({ ...base, selected: request, signal: new AbortController().signal })
    assert.deepEqual(switched.quality?.mode, mode)
    assert.equal(switched.quality?.requested, target)
    preparation.releaseOwner(1)
    await switched.finished()
    switched.release(); current.release()
    const count = urls.length
    const offline = await cache.acquire({ ...make(target!), open: async () => { throw new Error('Offline') } })
    assert.equal(offline.progress().complete, true)
    assert.equal(urls.length, count, 'adapted representation is retained for offline playback')
    offline.release()
  }
  assert.equal(urls.length, 4, 'shared current/hold/decoder leases do not duplicate provider requests')
})
