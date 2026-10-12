import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubsonicAudioSource } from './subsonicAudioSource.ts'
import { remoteAudioCacheKey } from './remoteAudioCache.ts'
import { STREAMING_BITRATES } from '../../types/streamingQuality.ts'

const options = { sourceId: 7, trackId: 'song /1', revision: '1',
  connection: { baseUrl: 'https://music.example/navi/', username: 'listener', password: 'secret' } }

test('Subsonic manual targets explicitly request Opus, while Original keeps raw bytes and unlimited bitrate', async t => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    requests.push(new URL(input))
    assert.equal(new Headers(init.headers).get('Accept-Encoding'), 'identity')
    return new Response('audio')
  })
  const controller = new AbortController()
  const original = createSubsonicAudioSource(options)
  await original.open(controller.signal)
  assert.equal(requests[0].searchParams.get('format'), 'raw')
  assert.equal(requests[0].searchParams.get('maxBitRate'), '0')
  const keys = new Set([remoteAudioCacheKey(original)])
  for (const quality of STREAMING_BITRATES) {
    const source = createSubsonicAudioSource({ ...options, quality })
    await source.open(controller.signal)
    const url = requests.at(-1)!
    assert.equal(url.searchParams.get('format'), 'opus')
    assert.equal(url.searchParams.get('id'), options.trackId)
    assert.equal(url.searchParams.get('maxBitRate'), String(quality))
    assert.equal(url.searchParams.get('estimateContentLength'), null, 'estimated lengths cannot validate retained files')
    assert.ok(!source.account.includes('secret'))
    keys.add(remoteAudioCacheKey(source))
  }
  assert.equal(keys.size, 6)
})

test('Subsonic compatibility asks for unlimited FLAC or forced Opus/MP3 at the selected limit', async t => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(new URL(url)); return new Response('audio') })
  const keys = new Set<string>()
  for (const [quality, compatibility, bitrate] of [['original', 'flac', '0'], ['original', 'opus', '320'], [64, 'opus', '64'], ['original', 'mp3', '320'], [64, 'mp3', '64']] as const) {
    const source = createSubsonicAudioSource({ ...options, quality, compatibility })
    await source.open(new AbortController().signal)
    assert.equal(requests.at(-1)!.searchParams.get('format'), compatibility)
    assert.equal(requests.at(-1)!.searchParams.get('maxBitRate'), bitrate)
    const key = remoteAudioCacheKey(source)
    assert.notEqual(key, remoteAudioCacheKey(createSubsonicAudioSource({ ...options, quality })))
    keys.add(key)
  }
  assert.equal(keys.size, 5)
})
