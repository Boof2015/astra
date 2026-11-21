import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mainHarness } from '../../scripts/stratum/mainHarness.ts'
import { RemoteAudioCache } from './services/remoteAudioCache.ts'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('Standard Original Opus starts with the tail withheld, then preserves exact PCM and warm seeking', { timeout: 15000 }, async t => {
  const frames = 24 * 48000 + 317
  const encoded = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000',
    '-af', `atrim=end_sample=${frames}`, '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', '-f', 'opus', 'pipe:1'])
  const reference = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-f', 'f32le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { input: encoded, maxBuffer: 16 * 1024 ** 2 })
  const directory = await mkdtemp(join(tmpdir(), 'astra-original-opus-startup-'))
  const referencePath = join(directory, 'reference.opus')
  await writeFile(referencePath, encoded)
  const cache = new RemoteAudioCache(directory)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let requests = 0
  const source = { provider: 'fixture', account: 'fixture', track: 'original-opus', revision: '1', representation: 'original',
    open: async () => { requests++; return new Response(new ReadableStream<Uint8Array>({ start(c) { upstream = c } }), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(encoded.length) }
    }) } }
  // This track is deliberately outside the Stratum allowlist. Main startup,
  // the retained cache, FFmpeg and PCM delivery are real; no Electron/device.
  const h = mainHarness({ sourceId: 1, tracks: ['unused'], endpoint: 'http://127.0.0.1:1', session: 'a'.repeat(64) }, ffmpeg, {
    duration: () => frames / 48000,
    acquire: async (_path, signal) => ({ ...await cache.acquire(source, signal),
      quality: { requested: 'original', requestedCodec: null, delivered: null } })
  })
  t.after(async () => { await h.close(); await cache.close(); await rm(directory, { recursive: true, force: true }) })
  const held = await cache.acquire(source)
  t.after(held.release)
  while (!upstream) await delay(1)
  const split = Math.floor(encoded.length / 2)
  upstream.enqueue(encoded.subarray(0, split))
  let deadline: ReturnType<typeof setTimeout> | undefined
  const info = await Promise.race([
    h.startOptions('jellyfin://1/song', 48000, 2, { streamingQuality: 'original' }),
    new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Startup waited for the withheld Opus tail')), 5000) })
  ]).finally(() => clearTimeout(deadline))
  assert.equal(held.progress().complete, false)
  assert.ok(info.initialChunk!.frameCount > 0)
  upstream.enqueue(encoded.subarray(split)); upstream.close()
  const collect = async (started: typeof info) => {
    const tick = setInterval(() => h.ready(started.sessionId), 2)
    try {
      const until = Date.now() + 5000
      while (!h.events.some(e => e.sessionId === started.sessionId && ['failed', 'complete'].includes(e.type))) {
        assert.ok(Date.now() < until, 'decode did not complete')
        await delay(5)
      }
      assert.equal(h.events.some(e => e.sessionId === started.sessionId && e.type === 'failed'), false)
      return Buffer.concat([Buffer.from(started.initialChunk!.pcmData),
        ...h.chunks.filter(c => c.sessionId === started.sessionId).map(c => Buffer.from(c.pcmData))])
    } finally { clearInterval(tick); await h.cancel(started.sessionId) }
  }
  const pcm = await collect(info)
  assert.equal(pcm.length, frames * 8, 'Opus pre-skip and final padding still give the exact gapless length')
  assert.deepEqual(pcm, reference)
  const sought = await collect(await h.startOptions('jellyfin://1/song', 48000, 2, { streamingQuality: 'original', startTimeSeconds: 12 }))
  // The warm seek retains the existing decoder's random-access behavior.
  const expectedSeek = execFileSync(ffmpeg, ['-v', 'error', '-ss', '12', '-i', referencePath, '-map', '0:a:0', '-f', 'f32le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { maxBuffer: 16 * 1024 ** 2 })
  assert.deepEqual(sought, expectedSeek)
  assert.equal(requests, 1, 'starting and seeking reuse the same retained response')
})
