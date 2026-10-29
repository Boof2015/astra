import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createPlexAudioSource } from './plexAudioSource.ts'
import { RemoteAudioCache } from './remoteAudioCache.ts'
import type { PlexCredentials } from './plex.ts'
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
async function decode(url: string, seek = 0): Promise<Buffer> {
  const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', ...(seek ? ['-ss', String(seek)] : []), '-i', url,
    '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'])
  const chunks: Buffer[] = []; let error = ''
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => { error += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error)))
  })
}

test('Plex original and Opus use the real retained cache, FFmpeg seeking and offline replay', { timeout: 20000 }, async t => {
  const frames = 480037
  const encode = (codec: string, format: string) => execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=997:sample_rate=48000', '-af', `atrim=end_sample=${frames}`, '-ac', '2', '-c:a', codec,
    ...(codec === 'libopus' ? ['-b:a', '64k'] : []), '-f', format, 'pipe:1'], { maxBuffer: 4 * 1024 ** 2 })
  const original = encode('flac', 'flac'), opus = encode('libopus', 'ogg')
  const directory = await mkdtemp(join(tmpdir(), 'astra-plex-audio-'))
  let cache = new RemoteAudioCache(directory, 8 * 1024 ** 2)
  let authentications = 0, audioRequests = 0
  const server = createServer((req, res) => {
    if (req.headers['x-plex-token'] !== 'server-token') { res.writeHead(401); res.end(); return }
    const url = new URL(req.url!, 'http://fixture')
    if (url.pathname === '/library/metadata/123') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ MediaContainer: { Metadata: [{ type: 'track', ratingKey: '123', Media: [{ Part: [{ key: '/library/parts/123/1/file.flac' }] }] }] } })); return
    }
    audioRequests++
    const bytes = url.pathname.endsWith('.ogg') ? opus : original
    res.setHeader('Content-Type', url.pathname.endsWith('.ogg') ? 'audio/ogg' : 'audio/flac')
    res.setHeader('Content-Length', bytes.length)
    // Split each encoded response to exercise the streaming/cache handoff.
    res.write(bytes.subarray(0, Math.floor(bytes.length / 2)))
    setTimeout(() => res.end(bytes.subarray(Math.floor(bytes.length / 2))), 30)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { await cache.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const address = server.address() as { port: number }
  const credentials = { account: { clientId: 'test-client' }, server: { token: 'server-token' }, baseUrl: `http://127.0.0.1:${address.port}` } as PlexCredentials
  for (const quality of ['original', 64] as const) {
    const options = { sourceId: 1, accountId: 'account', serverId: 'server', libraryId: '2', trackId: '123', revision: '1', quality,
      credentials: async () => { authentications++; return credentials } }
    const lease = await cache.acquire(createPlexAudioSource(options))
    const pcm = await decode(lease.url)
    assert.equal(pcm.length, frames * 2 * 4, 'Plex adapter must preserve Opus trim metadata and original frame count')
    await lease.finished()
    const sought = await decode(lease.url, 2)
    assert.equal(sought.length, (frames - 2 * 48000) * 2 * 4)
    if (quality === 'original') assert.deepEqual(sought, pcm.subarray(2 * 48000 * 2 * 4))
    lease.release()
    await cache.close()
    cache = new RemoteAudioCache(directory, 8 * 1024 ** 2)
    const offline = await cache.acquire(createPlexAudioSource({ ...options, credentials: async () => { throw new Error('offline: credentials must not be needed') } }))
    assert.deepEqual(await decode(offline.url), pcm)
    offline.release()
  }
  assert.equal(authentications, 2); assert.equal(audioRequests, 2)
})
