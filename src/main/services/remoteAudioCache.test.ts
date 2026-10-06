import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteAudioCache, remoteAudioCacheKey, type RemoteAudioSource } from './remoteAudioCache.ts'

function audioResponse(data: string): Response {
  return new Response(Buffer.from(data), { headers: { 'content-type': 'audio/flac' } })
}

function source(track: string, open: RemoteAudioSource['open']): RemoteAudioSource {
  return { provider: 'subsonic', account: 'server/account', track, representation: 'original', revision: '1', open }
}

async function fixture(t: TestContext, limit = 1024) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-remote-cache-'))
  const cache = new RemoteAudioCache(directory, limit)
  t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }) })
  return { cache, directory }
}

test('identity separates provider, account, representation and revision without storing credentials', () => {
  const original = source('song', async () => audioResponse('data'))
  for (const field of ['provider', 'account', 'track', 'representation', 'revision'] as const) {
    assert.notEqual(remoteAudioCacheKey(original), remoteAudioCacheKey({ ...original, [field]: 'other' }))
  }
  assert.match(remoteAudioCacheKey(original), /^[a-f0-9]{64}$/)
})

test('decoders read partial data before completion and backward ranges reuse disk bytes', async t => {
  const { cache } = await fixture(t)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  const lease = await cache.acquire(source('progressive', async () => new Response(
    new ReadableStream({ start(controller) { upstream = controller; opened() } }),
    { headers: { 'content-length': '12', 'content-type': 'audio/flac' } }
  )))
  await ready
  upstream.enqueue(Buffer.from('first!'))
  const first = await fetch(lease.url, { headers: { Range: 'bytes=0-5' } })
  assert.equal(first.status, 206)
  assert.equal(await first.text(), 'first!')
  assert.equal(lease.progress().complete, false)
  const pending = fetch(lease.url, { headers: { Range: 'bytes=6-' } }).then(response => response.text())
  upstream.enqueue(Buffer.from('later!'))
  upstream.close()
  assert.equal(await pending, 'later!')
  assert.equal(await (await fetch(lease.url, { headers: { Range: 'bytes=0-4' } })).text(), 'first')
  assert.equal(await (await fetch(lease.url, { headers: { Range: 'bytes=-6' } })).text(), 'later!')
  assert.equal((await fetch(lease.url, { headers: { Range: 'bytes=12-' } })).status, 416)
  lease.release()
})

test('complete audio survives process restart and plays without contacting the source', async t => {
  const { cache, directory } = await fixture(t)
  let requests = 0
  const audio = source('retained', async () => { requests++; return audioResponse('original bytes') })
  const lease = await cache.acquire(audio)
  assert.equal(await (await fetch(lease.url)).text(), 'original bytes')
  // EOF is sent only once completion metadata is committed.
  assert.equal(lease.progress().complete, true)
  lease.release()
  await cache.close()
  const reopened = new RemoteAudioCache(directory)
  t.after(() => reopened.close())
  const warm = await reopened.acquire({ ...audio, open: async () => { throw new Error('offline') } })
  assert.equal(await (await fetch(warm.url)).text(), 'original bytes')
  assert.equal(requests, 1)
  warm.release()
})

test('eviction is oldest-first and clear leaves leased audio retained after release', async t => {
  const { cache } = await fixture(t, 12)
  let firstRequests = 0
  const firstSource = source('first', async () => { firstRequests++; return audioResponse('111111') })
  const first = await cache.acquire(firstSource)
  await (await fetch(first.url)).text()
  const second = await cache.acquire(source('second', async () => audioResponse('222222')))
  await (await fetch(second.url)).text()
  second.release()
  await cache.clearUnused()
  first.release()
  const warm = await cache.acquire(firstSource)
  assert.equal(await (await fetch(warm.url)).text(), '111111')
  assert.equal(firstRequests, 1, 'clear must not defer deletion of active audio')
  warm.release()
  const third = await cache.acquire(source('third', async () => audioResponse('333333333333')))
  assert.equal(await (await fetch(third.url)).text(), '333333333333')
  assert.equal((await fetch(first.url)).status, 404)
  third.release()
})

test('interrupted and error responses cannot become retained complete audio', async t => {
  const { cache, directory } = await fixture(t)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  let requests = 0
  const audio = source('broken', async () => {
    if (requests++ > 0) throw new Error('still offline')
    return new Response(new ReadableStream({
    start(controller) { upstream = controller; opened() }
    }), { headers: { 'content-length': '20' } })
  })
  const lease = await cache.acquire(audio)
  await ready
  upstream.enqueue(Buffer.from('partial'))
  const response = await fetch(lease.url)
  upstream.error(new Error('connection lost'))
  await assert.rejects(response.text())
  await assert.rejects(lease.finished(), /download failed/)
  lease.release()
  await cache.close()
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.json')))
})

test('warm startup rejects truncated files and removes interrupted writes', async t => {
  const { directory } = await fixture(t)
  const audio = source('truncated', async () => audioResponse('new bytes'))
  const key = remoteAudioCacheKey(audio)
  await writeFile(join(directory, `${key}.audio`), 'bad')
  await writeFile(join(directory, `${key}.json`), JSON.stringify({ version: 1, bytes: 100, lastPlayed: 1, contentType: 'audio/flac' }))
  const reopened = new RemoteAudioCache(directory)
  t.after(() => reopened.close())
  const lease = await reopened.acquire(audio)
  assert.equal(await (await fetch(lease.url)).text(), 'new bytes')
  lease.release()
})

test('concurrent decoders share one download; releasing one does not cancel the other', async t => {
  const { cache } = await fixture(t)
  let requests = 0
  const audio = source('shared', async () => { requests++; return audioResponse('shared original') })
  const [first, second] = await Promise.all([cache.acquire(audio), cache.acquire(audio)])
  assert.equal(first.url, second.url)
  first.release()
  assert.equal(await (await fetch(second.url)).text(), 'shared original')
  assert.equal(requests, 1)
  second.release()
})

test('a seek reuses an unfinished download, while abandoned work is cancelled and can restart', async t => {
  const { cache } = await fixture(t)
  let requests = 0
  let cancelled = 0
  const audio = source('cancel-restart', async signal => {
    requests++
    signal.addEventListener('abort', () => { cancelled++ }, { once: true })
    if (requests > 1) return audioResponse('restart')
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('prefix')) }
    }), { headers: { 'content-length': '12' } })
  })
  const first = await cache.acquire(audio)
  assert.equal(await (await fetch(first.url, { headers: { Range: 'bytes=0-5' } })).text(), 'prefix')
  first.release()
  const replacement = await cache.acquire(audio)
  assert.equal(replacement.url, first.url)
  assert.equal(requests, 1)
  replacement.release()
  await delay(1100)
  assert.equal(cancelled, 1)
  const restarted = await cache.acquire(audio)
  assert.equal(await (await fetch(restarted.url)).text(), 'restart')
  assert.equal(requests, 2)
  restarted.release()
})

test('lowering the cache limit protects current audio and trims it after release', async t => {
  const { cache } = await fixture(t, 12)
  const lease = await cache.acquire(source('limit', async () => audioResponse('123456789012')))
  await (await fetch(lease.url)).text()
  await cache.setLimitBytes(6)
  assert.deepEqual(await cache.status(), { usedBytes: 12, activeBytes: 12 })
  await cache.clearUnused()
  assert.equal((await cache.status()).usedBytes, 12)
  lease.release()
  assert.equal((await cache.status()).usedBytes, 0)
})

test('replaying a retained entry refreshes eviction order within the same process', async t => {
  const { cache, directory } = await fixture(t, 12)
  const firstSource = source('least-recent-a', async () => audioResponse('aaaaaa'))
  const secondSource = source('least-recent-b', async () => audioResponse('bbbbbb'))
  const first = await cache.acquire(firstSource)
  await (await fetch(first.url)).text()
  first.release()
  await delay(2)
  const second = await cache.acquire(secondSource)
  await (await fetch(second.url)).text()
  second.release()
  await delay(2)
  const replay = await cache.acquire(firstSource)
  replay.release()
  const third = await cache.acquire(source('least-recent-c', async () => audioResponse('cccccc')))
  await (await fetch(third.url)).text()
  const files = await readdir(directory)
  assert.ok(files.includes(`${remoteAudioCacheKey(firstSource)}.audio`))
  assert.ok(!files.includes(`${remoteAudioCacheKey(secondSource)}.audio`))
  third.release()
})

test('protected audio prevents over-budget download, and JSON errors are never cached', async t => {
  const { cache } = await fixture(t, 6)
  const first = await cache.acquire(source('protected', async () => audioResponse('123456')))
  await (await fetch(first.url)).text()
  const overflow = await cache.acquire(source('overflow', async () => audioResponse('x')))
  await assert.rejects(fetch(overflow.url))
  assert.equal(await (await fetch(first.url)).text(), '123456')
  const invalid = await cache.acquire(source('invalid', async () => Response.json({ error: 'denied' })))
  await assert.rejects(fetch(invalid.url))
  first.release(); overflow.release(); invalid.release()
})

test('interrupted download recovers at the same byte position without duplicating the prefix', async t => {
  const { cache } = await fixture(t)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  let requests = 0
  const lease = await cache.acquire(source('recovery', async () => {
    if (requests++ > 0) return audioResponse('first!later!')
    return new Response(new ReadableStream({ start(controller) { upstream = controller; opened() } }), {
      headers: { 'content-length': '12' }
    })
  }))
  await ready
  upstream.enqueue(Buffer.from('first!'))
  const first = await fetch(lease.url, { headers: { Range: 'bytes=0-5' } })
  assert.equal(await first.text(), 'first!')
  upstream.error(new Error('connection reset'))
  const rest = await fetch(lease.url, { headers: { Range: 'bytes=6-' } })
  assert.equal(await rest.text(), 'later!')
  assert.equal(await (await fetch(lease.url)).text(), 'first!later!')
  assert.equal(requests, 2)
  lease.release()
})

test('recovery rejects changed audio instead of splicing representations', async t => {
  const { cache } = await fixture(t)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  let requests = 0
  const lease = await cache.acquire(source('changed', async () => {
    if (requests++ > 0) return audioResponse('other!later!')
    return new Response(new ReadableStream({ start(controller) { upstream = controller; opened() } }), {
      headers: { 'content-length': '12' }
    })
  }))
  await ready
  upstream.enqueue(Buffer.from('first!'))
  assert.equal(await (await fetch(lease.url, { headers: { Range: 'bytes=0-5' } })).text(), 'first!')
  upstream.error(new Error('connection reset'))
  await assert.rejects(async () => (await fetch(lease.url, { headers: { Range: 'bytes=6-' } })).text())
  assert.equal(lease.progress().complete, false)
  lease.release()
})

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

function decode(input: string, start = 0): { firstPcm: Promise<void>; result: Promise<Buffer> } {
  const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', ...(start ? ['-ss', String(start)] : []),
    '-i', input, '-map', '0:a:0', '-f', 'f32le', '-ar', '48000', '-ac', '2', 'pipe:1'])
  const chunks: Buffer[] = []
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })
  const firstPcm = new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('error', reject)
    child.once('close', () => { if (!chunks.length) reject(new Error(stderr || 'No PCM decoded')) })
  })
  const result = new Promise<Buffer>((resolve, reject) => {
    child.stdout.on('data', data => chunks.push(data))
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr)))
  })
  // Consumers may be waiting for firstPcm when a process fails.
  void result.catch(() => undefined)
  return { firstPcm, result }
}

test('real FFmpeg starts before download completion and accurately seeks retained original audio', { timeout: 15_000 }, async t => {
  const { cache } = await fixture(t, 32 * 1024 ** 2)
  const wav = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=20',
    '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 16 * 1024 ** 2 })
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller } })
  const lease = await cache.acquire(source('ffmpeg-wav', async () => new Response(body, {
    headers: { 'content-type': 'audio/wav', 'content-length': String(wav.length) }
  })))
  upstream.enqueue(wav.subarray(0, 1536 * 1024))
  const playing = decode(lease.url)
  await playing.firstPcm
  assert.equal(lease.progress().complete, false, 'cold playback must not wait for the complete track')
  upstream.enqueue(wav.subarray(1536 * 1024))
  upstream.close()
  const full = await playing.result
  await lease.finished()
  assert.equal(full.length, 20 * 48000 * 2 * 4)
  const sought = await decode(lease.url, 12).result
  assert.deepEqual(sought, full.subarray(12 * 48000 * 2 * 4))
  lease.release()
})

test('real FFmpeg can decode an original M4A whose index follows its audio', { timeout: 15_000 }, async t => {
  const { cache, directory } = await fixture(t, 4 * 1024 ** 2)
  const m4aPath = join(directory, 'source.m4a')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=4',
    '-ac', '2', '-c:a', 'aac', m4aPath])
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(m4aPath)
  assert.ok(bytes.indexOf(Buffer.from('moov')) > bytes.indexOf(Buffer.from('mdat')))
  const lease = await cache.acquire(source('ffmpeg-m4a', async () => new Response(bytes, {
    headers: { 'content-type': 'audio/mp4', 'content-length': String(bytes.length) }
  })))
  const actual = await decode(lease.url).result
  const expected = await decode(m4aPath).result
  assert.deepEqual(actual, expected)
  const sought = await decode(lease.url, 2).result
  const expectedSeek = await decode(m4aPath, 2).result
  assert.deepEqual(sought, expectedSeek)
  lease.release()
})

test('adjacent cached FLAC tracks decode to the original continuous PCM without boundary padding', { timeout: 15_000 }, async t => {
  const { cache } = await fixture(t, 4 * 1024 ** 2)
  const boundary = 48_037
  const frames = boundary + 48_091
  const pcm = Buffer.alloc(frames * 4)
  const expected = Buffer.alloc(frames * 8)
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      // Integer PCM has one zero representation (Math.round can return -0).
      const sample = Math.round(12_000 * Math.sin(frame * (channel ? 0.071 : 0.043))) || 0
      pcm.writeInt16LE(sample, frame * 4 + channel * 2)
      expected.writeFloatLE(sample / 32_768, frame * 8 + channel * 4)
    }
  }
  const encode = (input: Buffer) => execFileSync(ffmpeg, [
    '-v', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'flac', '-f', 'flac', 'pipe:1'
  ], { input, maxBuffer: 4 * 1024 ** 2 })
  const encoded = [encode(pcm.subarray(0, boundary * 4)), encode(pcm.subarray(boundary * 4))]
  const leases = await Promise.all(encoded.map((bytes, index) => cache.acquire(source(`adjacent-${index}`,
    async () => new Response(bytes, { headers: { 'content-type': 'audio/flac', 'content-length': String(bytes.length) } })))))
  const decoded = await Promise.all(leases.map(lease => decode(lease.url).result))
  assert.equal(decoded[0].length, boundary * 8)
  assert.deepEqual(Buffer.concat(decoded), expected)
  await cache.clearUnused()
  const status = await cache.status()
  assert.equal(status.usedBytes, encoded[0].length + encoded[1].length)
  assert.equal(status.activeBytes, status.usedBytes, 'current and prepared tracks remain protected')
  for (const lease of leases) lease.release()
})
