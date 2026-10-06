import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireQualityAudio } from './streamingQualityAcquisition.ts'
import { AutomaticStreamingQuality } from './automaticStreamingQuality.ts'
import { streamingRepresentation } from '../../types/streamingQuality.ts'

test('automatic selection shares provider targets, prefers complete original audio, and pins seeks without changing their mode', async () => {
  let now = 0
  const policy = new AutomaticStreamingQuality(() => now)
  const observer = policy.observer('server')
  observer({ phase: 'start' })
  for (let i = 0; i < 5; i++) { now += 1000; observer({ phase: 'data', bytes: 37_500 }) }
  observer({ phase: 'end' })
  const requested: string[] = []
  let cachedOriginal = false
  const options = { policy, key: 'server', originalKbps: 2000, track: { codec: 'flac', bitrate: 2000 },
    signal: new AbortController().signal,
    make: (quality: import('../../types/streamingQuality.ts').StreamQualityTarget) => ({ provider: 'fixture', account: 'a',
      track: 'song', revision: '1', representation: streamingRepresentation(quality), open: async () => new Response() }),
    cache: { hasComplete: async (source: { representation: string }) => cachedOriginal && source.representation === 'original',
      acquire: async (source: { representation: string }) => {
        requested.push(source.representation)
        return { url: 'http://cache/internal', progress: () => ({ loadedBytes: 0, totalBytes: null, complete: cachedOriginal }),
          release() {}, finished: async () => {} }
      } }
  }
  const reduced = await acquireQualityAudio({ ...options, selected: 'automatic' })
  assert.equal(reduced.quality?.requested, 192)
  assert.equal(reduced.quality?.mode, 'automatic')
  cachedOriginal = true
  const cached = await acquireQualityAudio({ ...options, selected: 'automatic' })
  assert.equal(cached.quality?.requested, 'original')
  const seek = await acquireQualityAudio({ ...options, selected: { mode: 'automatic', target: 192 } })
  assert.equal(seek.quality?.requested, 192, 'a seek keeps its representation even when another copy is cached')
  assert.equal(seek.quality?.mode, 'automatic')
  assert.deepEqual(requested, ['mp3:192:v1', 'original', 'mp3:192:v1'])
  const manual = await acquireQualityAudio({ ...options, selected: 64 })
  assert.equal(manual.quality?.requested, 64)
  assert.equal(manual.quality?.mode, undefined)
})

test('candidate acquisition does not commit a policy change before playback adopts it', async () => {
  const policy = new AutomaticStreamingQuality()
  await acquireQualityAudio({ policy, key: 's', originalKbps: 1500, track: null,
    signal: new AbortController().signal, selected: { mode: 'automatic', target: 64 },
    make: quality => ({ provider: 'fixture', account: 'a', track: 'song', revision: '1', representation: String(quality), open: async () => new Response() }),
    cache: { hasComplete: async () => false, acquire: async () => ({ url: 'fixture', progress: () => ({ complete: false, loadedBytes: 0, totalBytes: null }),
      release() {}, finished: async () => {} }) } })
  assert.equal(policy.select('s', 'automatic', 1500), 'original')
})

for (const offline of [false, true]) {
  test(`a cached lower-quality copy ${offline ? 'is available offline' : 'does not cap a healthy connection'}`, async () => {
    const requests: string[] = []
    const result = await acquireQualityAudio({ policy: new AutomaticStreamingQuality(), key: 'server', originalKbps: 1500,
      track: null, selected: 'automatic-original', signal: new AbortController().signal,
      make: quality => ({ provider: 'fixture', account: 'a', track: 'song', revision: '1', representation: streamingRepresentation(quality), open: async () => new Response() }),
      cache: { hasComplete: async source => source.representation === 'mp3:64:v1', acquire: async source => {
        requests.push(source.representation)
        const missing = offline && source.representation === 'original'
        return { url: 'fixture', progress: () => ({ complete: !missing, loadedBytes: missing ? 0 : 100, totalBytes: 100 }),
          release() {}, finished: async () => { if (missing) throw new Error('Offline') } }
      } }
    })
    assert.equal(result.quality?.requested, offline ? 64 : 'original')
    assert.equal(result.quality?.mode, 'automatic-original')
    assert.equal(requests.length, offline ? 2 : 1)
  })
}
