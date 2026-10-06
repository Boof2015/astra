import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubsonicAudioSource } from './subsonicAudioSource.ts'
import { remoteAudioCacheKey } from './remoteAudioCache.ts'
import { STREAMING_BITRATES } from '../../types/streamingQuality.ts'

const options = { sourceId: 7, trackId: 'song /1', revision: '1',
  connection: { baseUrl: 'https://music.example/navi/', username: 'listener', password: 'secret' } }

test('Subsonic manual targets explicitly request MP3, while Original keeps raw bytes and unlimited bitrate', async t => {
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
    assert.equal(url.searchParams.get('format'), 'mp3')
    assert.equal(url.searchParams.get('id'), options.trackId)
    assert.equal(url.searchParams.get('maxBitRate'), String(quality))
    assert.equal(url.searchParams.get('estimateContentLength'), null, 'estimated lengths cannot validate retained files')
    assert.ok(!source.account.includes('secret'))
    keys.add(remoteAudioCacheKey(source))
  }
  assert.equal(keys.size, 6)
})
