import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { RemoteAudioCache } from './remoteAudioCache.ts'
import { createSubsonicAudioSource } from './subsonicAudioSource.ts'
import { createJellyfinAudioSource } from './jellyfinAudioSource.ts'
import { deliveredAudioFormat, type StreamingQuality } from '../../types/streamingQuality.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string
const ffprobe = require('ffprobe-static').path as string
const run = promisify(execFile)

test('real encoded quality variants decode, seek and replay offline from distinct retained files for both providers', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'astra-quality-audio-'))
  const original = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=sample_rate=48000:duration=10:seed=1',
    '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 })
  const variants = new Map<StreamingQuality, Buffer>([['original', original]])
  for (const quality of [64, 320] as const) variants.set(quality, execFileSync(ffmpeg, [
    '-v', 'error', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', `${quality}k`, '-f', 'mp3', 'pipe:1'
  ], { input: original, maxBuffer: 2 * 1024 * 1024 }))
  assert.ok(variants.get(64)!.length < variants.get(320)!.length)
  assert.ok(variants.get(320)!.length < original.length)
  const requests: URL[] = []
  let finishPartial: (() => void) | null = null
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    requests.push(url)
    const quality = url.searchParams.get('format') === 'raw' || url.searchParams.get('static') === 'true'
      ? 'original' : Number(url.searchParams.get('maxBitRate') ?? Number(url.searchParams.get('AudioBitRate')) / 1000) as StreamingQuality
    const data = variants.get(quality)
    if (!data) { response.writeHead(400).end(); return }
    response.writeHead(200, { 'Content-Type': quality === 'original' ? 'audio/wav' : 'audio/mpeg' })
    // Exercise chunked server transcodes without a Content-Length header.
    response.write(data.subarray(0, 16384))
    if (url.searchParams.get('maxBitRate') === '64') finishPartial = () => response.end(data.subarray(16384))
    else setImmediate(() => response.end(data.subarray(16384)))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const connection = { baseUrl: `http://127.0.0.1:${address.port}`, username: 'fixture', password: 'fixture' }
  const cache = new RemoteAudioCache(folder)
  t.after(async () => {
    await cache.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(folder, { recursive: true, force: true })
  })
  const sources = []
  for (const provider of ['subsonic', 'jellyfin']) {
    for (const quality of ['original', 64, 320] as const) {
      const options = { sourceId: 1, trackId: 'song', revision: '1', connection, quality }
      const source = provider === 'subsonic' ? createSubsonicAudioSource(options)
        : createJellyfinAudioSource({ ...options, authenticate: async () => ({ accessToken: 'fixture', userId: 'fixture' }) })
      sources.push(source)
      const lease = await cache.acquire(source)
      const { stdout } = await run(ffprobe, ['-v', 'error', '-analyzeduration', '100000', '-probesize', '65536',
        '-show_streams', '-of', 'json', lease.url], { timeout: 3000 })
      if (provider === 'subsonic' && quality === 64) {
        assert.equal(lease.progress().complete, false, 'format inspection must not wait for the whole transcode')
        const finish = finishPartial as (() => void) | null
        assert.ok(finish)
        finish()
      }
      const delivered = deliveredAudioFormat(JSON.parse(stdout))
      assert.equal(delivered?.codec, quality === 'original' ? 'pcm_s16le' : 'mp3')
      if (quality !== 'original') assert.equal(delivered?.bitrateKbps, quality)
      const decoded = await run(ffmpeg, ['-v', 'error', '-ss', '0.5', '-i', lease.url, '-t', '0.1',
        '-map', '0:a:0', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', timeout: 10000 })
      assert.ok(decoded.stdout.length >= 4800 * 4, 'seeks produce real decoded audio')
      await lease.finished()
      assert.equal(lease.progress().loadedBytes, variants.get(quality)!.length)
      lease.release()
    }
  }
  assert.equal(requests.length, 6)
  await cache.close()
  const reopened = new RemoteAudioCache(folder)
  t.after(() => reopened.close())
  for (const source of sources) {
    const lease = await reopened.acquire({ ...source, open: async () => { throw new Error('Offline') } })
    assert.equal(lease.progress().complete, true)
    const response = await fetch(lease.url, { headers: { Range: 'bytes=0-31' } })
    assert.equal((await response.arrayBuffer()).byteLength, 32)
    lease.release()
  }
  assert.equal(requests.length, 6, 'cached replay never authenticates or opens the server')
  await reopened.close()
})
