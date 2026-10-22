import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { RemoteAudioCache } from './remoteAudioCache.ts'
import { acquireQualityAudio } from './streamingQualityAcquisition.ts'
import { AutomaticStreamingQuality } from './automaticStreamingQuality.ts'
import { createSubsonicAudioSource } from './subsonicAudioSource.ts'
import { createJellyfinAudioSource } from './jellyfinAudioSource.ts'
import { isUnsupportedRemoteDecoder, RemoteCompatibilityFailure, withRemoteCompatibility } from '../../shared/audio/remoteCompatibility.ts'
import { playbackQualityRequest, type RemoteCompatibilityCodec, type StreamingQualityRequest, type StreamQualityTarget } from '../../types/streamingQuality.ts'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const execute = promisify(execFile)

for (const provider of ['subsonic', 'jellyfin'] as const) {
  test(`${provider}: real decoder failure retries retained FLAC and reuses it offline after restart`, { timeout: 15000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'astra-compatible-'))
    let cache = new RemoteAudioCache(join(directory, 'cache'))
    t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }) })
    const input = join(directory, 'unsupported.m4a')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:a', 'aac', input])
    // A valid container with an unknown sample entry produces the real missing-
    // decoder diagnostic, without shipping a proprietary codec fixture.
    const unsupported = await readFile(input)
    unsupported.write('zzzz', unsupported.indexOf(Buffer.from('mp4a')))
    unsupported.write('free', unsupported.indexOf(Buffer.from('esds')))
    await writeFile(input, unsupported)
    const flac = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2',
      '-ac', '2', '-c:a', 'flac', '-f', 'flac', 'pipe:1'])
    const connection = { baseUrl: 'https://fixture.invalid/', username: 'test', password: 'test' }
    let online = true
    const requests: string[] = []
    const realFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (url: any, init?: RequestInit) => {
      if (!String(url).startsWith(connection.baseUrl)) return realFetch(url, init)
      assert.equal(online, true, 'offline replay must never contact the provider')
      const parsed = new URL(String(url))
      const codec = parsed.searchParams.get('format') ?? parsed.searchParams.get('AudioCodec') ?? 'raw'
      requests.push(codec)
      return new Response(codec === 'flac' ? flac : unsupported, { headers: { 'content-type': codec === 'flac' ? 'audio/flac' : 'audio/mp4' } })
    })
    const make = (quality: StreamQualityTarget, compatibility?: RemoteCompatibilityCodec) => {
      const options = { sourceId: 1, connection, trackId: 'song', revision: '1', quality, compatibility }
      return provider === 'subsonic' ? createSubsonicAudioSource(options)
        : createJellyfinAudioSource({ ...options, authenticate: async () => ({ accessToken: 'fixture', userId: '1' }) })
    }
    const acquire = (selected: StreamingQualityRequest) => acquireQualityAudio({ cache, make, selected,
      signal: new AbortController().signal, policy: new AutomaticStreamingQuality(), key: provider, originalKbps: 1000, track: null })
    const decode = (url: string, position = 0) => execute(ffmpeg, ['-v', 'error', '-ss', String(position), '-i', url,
      '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 ** 2 })
    const converted = await withRemoteCompatibility('original', new AbortController().signal, async request => {
      const lease = await acquire(request!)
      try {
        const decoded = await decode(lease.url)
        await lease.finished()
        assert.equal(decoded.stdout.length, 2 * 48000 * 2 * 4)
        return lease
      } catch (error) {
        lease.release()
        const diagnostic = String((error as { stderr?: Buffer }).stderr)
        assert.ok(isUnsupportedRemoteDecoder(diagnostic), diagnostic)
        throw new RemoteCompatibilityFailure(lease.quality!, diagnostic)
      }
    })
    assert.deepEqual(requests, ['raw', 'flac'])
    const pin = playbackQualityRequest(converted.quality)!
    assert.deepEqual(pin, { target: 'original', compatibility: 'flac' })
    converted.release()
    await cache.close()
    cache = new RemoteAudioCache(join(directory, 'cache'))
    online = false
    for (const request of ['original', pin] as const) {
      const offline = await acquire(request)
      assert.equal(offline.quality?.compatibility, 'flac')
      const sought = await decode(offline.url, 1)
      assert.equal(sought.stdout.length, 48000 * 2 * 4)
      offline.release()
    }
    assert.deepEqual(requests, ['raw', 'flac'])
  })
}
