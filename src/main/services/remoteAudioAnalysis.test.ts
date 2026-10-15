import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { analyzeRemoteAudioFile } from './remoteAudioAnalysis.ts'
import { RemoteAudioCache, type RemoteAudioSource } from './remoteAudioCache.ts'
import { isRemoteAudioAnalysis, type RemoteAudioAnalysis } from '../../types/remoteAudioAnalysis.ts'
import { buildEbur128Args, parseEbur128Summary } from './loudnessAnalysis.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string
const ffprobe = require('ffprobe-static').path as string
const result: RemoteAudioAnalysis = { version: 1, duration: 10, peaks: Array(512).fill(0.5), loudnessLufs: -18, peakLinear: 0.5 }
const source: RemoteAudioSource = { provider: 'subsonic', account: 'fixture', track: 'song', revision: '1', representation: 'original',
  open: async () => new Response(Buffer.from('complete audio')) }

test('background analysis waits for complete audio, never gates playback, persists and isolates representations', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-cache-analysis-'))
  let finish!: (value: RemoteAudioAnalysis) => void
  let runs = 0
  const ready: string[] = []
  const cache = new RemoteAudioCache(directory, 1024, {
    analyze: async file => { runs++; assert.equal(await readFile(file, 'utf8'), 'complete audio'); return new Promise(resolve => { finish = resolve }) },
    ready: key => { ready.push(key) }
  })
  t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }) })
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  const lease = await cache.acquire({ ...source, open: async () => new Response(new ReadableStream({ start(controller) { upstream = controller } }), { headers: { 'content-length': '14' } }) })
  while (!upstream) await delay(5)
  upstream.enqueue(Buffer.from('complete '))
  assert.equal(await (await fetch(lease.url, { headers: { Range: 'bytes=0-8' } })).text(), 'complete ')
  assert.equal(runs, 0, 'partial audio must not be scanned')
  upstream.enqueue(Buffer.from('audio')); upstream.close()
  await lease.finished()
  while (!finish) await delay(5)
  assert.equal(await (await fetch(lease.url)).text(), 'complete audio', 'scan cannot gate playback')
  assert.equal(await cache.getAnalysis(lease.cacheKey!), null)
  assert.equal(lease.analysis, undefined)
  finish(result)
  while (!ready.length) await delay(5)
  assert.deepEqual(await cache.getAnalysis(lease.cacheKey!), result)
  assert.equal(lease.analysis, undefined, 'late analysis must not mutate an existing playback snapshot')
  const warm = await cache.acquire(source)
  assert.deepEqual(warm.analysis, result)
  assert.equal(runs, 1)
  warm.release(); lease.release()
  await cache.close()
  const reopened = new RemoteAudioCache(directory, 1024)
  t.after(() => reopened.close())
  const offline = await reopened.acquire({ ...source, open: async () => { throw new Error('offline') } })
  assert.deepEqual(offline.analysis, result)
  const converted = await reopened.acquire({ ...source, representation: 'mp3:128:v1' })
  assert.notEqual(converted.cacheKey, offline.cacheKey)
  assert.equal(converted.analysis, undefined)
  await converted.finished()
  offline.release(); converted.release()
})

test('cache shutdown cancels optional scanning without invalidating completed audio', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-cache-analysis-cancel-'))
  let scanning = false, aborted = false
  const cache = new RemoteAudioCache(directory, 1024, { analyze: async (_file, signal) => {
    scanning = true
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true }))
  }, ready: () => assert.fail('cancelled scan cannot publish') })
  t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }) })
  const lease = await cache.acquire(source)
  await lease.finished()
  while (!scanning) await delay(5)
  await cache.close()
  assert.equal(aborted, true)
  const reopened = new RemoteAudioCache(directory, 1024)
  t.after(() => reopened.close())
  const offline = await reopened.acquire({ ...source, open: async () => { throw new Error('offline') } })
  assert.equal(await (await fetch(offline.url)).text(), 'complete audio')
  assert.equal(offline.analysis, undefined)
  offline.release()
})

test('real background scan produces a complete compact waveform and the same loudness as the existing EBU pass', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-real-analysis-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'varying.wav')
  // Opposite-polarity stereo also proves waveform generation does not cancel
  // channels down to mono before measuring their energy.
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.4*sin(2*PI*440*t)*if(lt(t,4),0.1,1)|-0.4*sin(2*PI*440*t)*if(lt(t,4),0.1,1)':s=48000:d=8",
    '-c:a', 'pcm_s16le', file])
  const analysis = await analyzeRemoteAudioFile(file, ffmpeg, ffprobe, new AbortController().signal)
  assert.ok(isRemoteAudioAnalysis(analysis))
  assert.ok(Math.abs(analysis.duration - 8) < 0.01)
  assert.ok(analysis.peaks[64] < analysis.peaks[384] * 0.2)
  const { spawnSync } = await import('node:child_process')
  const reference = spawnSync(ffmpeg, buildEbur128Args(file), { encoding: 'utf8' })
  assert.equal(reference.status, 0)
  const expected = parseEbur128Summary(reference.stderr)!
  assert.equal(analysis.loudnessLufs, expected.loudnessLufs)
  assert.equal(analysis.peakLinear, expected.peakLinear)
  const invalid = join(directory, 'invalid.audio')
  await writeFile(invalid, 'not audio')
  await assert.rejects(analyzeRemoteAudioFile(invalid, ffmpeg, ffprobe, new AbortController().signal))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(analyzeRemoteAudioFile(file, ffmpeg, ffprobe, abort.signal))
})
