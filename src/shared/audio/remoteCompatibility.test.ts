import assert from 'node:assert/strict'
import test from 'node:test'
import { isUnsupportedRemoteDecoder, RemoteCompatibilityFailure, withRemoteCompatibility } from './remoteCompatibility.ts'
import { isStreamingQualityRequest, playbackQualityRequest, streamingRepresentation,
  type RemotePlaybackQuality, type StreamingQualityRequest } from '../../types/streamingQuality.ts'

const original: RemotePlaybackQuality = { requested: 'original', requestedCodec: null, delivered: null }

test('only explicit unsupported decoder diagnostics qualify, not generic media, connection or device failures', () => {
  for (const message of ['Decoder (codec ac4) not found for input stream #0:0',
    '[aist#0:0] Decoding requested, but no decoder found for: ac4', 'Audio decoder ac4 not supported in this build']) {
    assert.equal(isUnsupportedRemoteDecoder(message), true, message)
  }
  for (const message of ['Invalid data found when processing input', 'HTTP error 401 Unauthorized',
    'HTTP error 502 Bad Gateway', 'End of file', 'Connection timed out', 'unsupported sample rate',
    'Unsupported codec', 'Error opening audio device', 'No audio stream', 'Unknown encoder flac', 'Resource temporarily unavailable']) {
    assert.equal(isUnsupportedRemoteDecoder(message), false, message)
  }
})

test('unsupported Original retries lossless first, then Opus and MP3, while retaining automatic mode and an explicit conversion identity', async () => {
  const requests: Array<StreamingQualityRequest | undefined> = []
  await withRemoteCompatibility('automatic-original', new AbortController().signal, async request => {
    requests.push(request)
    const compatibility = typeof request === 'object' ? request.compatibility : undefined
    if (compatibility === 'mp3') return
    throw new RemoteCompatibilityFailure({ ...original, mode: 'automatic-original', compatibility }, 'Unsupported input')
  })
  assert.deepEqual(requests, ['automatic-original', { mode: 'automatic-original', target: 'original', compatibility: 'flac' },
    { mode: 'automatic-original', target: 'original', compatibility: 'opus' },
    { mode: 'automatic-original', target: 'original', compatibility: 'mp3' }])
  const pin = playbackQualityRequest({ ...original, compatibility: 'mp3', requestedCodec: 'mp3' })
  assert.deepEqual(pin, { target: 'original', compatibility: 'mp3' })
  assert.equal(isStreamingQualityRequest(pin), true)
  assert.equal(isStreamingQualityRequest({ target: 64, compatibility: 'flac' }), false)
  assert.equal(isStreamingQualityRequest({ target: 'original', compatibility: 'aac' }), false)
  assert.notEqual(streamingRepresentation('original', 'mp3'), streamingRepresentation(320))
})

test('manual limits retry forced MP3 once; ordinary errors and cancellation cannot trigger another request', async () => {
  const requests: unknown[] = []
  await assert.rejects(withRemoteCompatibility(64, new AbortController().signal, async request => {
    requests.push(request)
    throw new RemoteCompatibilityFailure({ ...original, requested: 64, requestedCodec: 'opus',
      compatibility: typeof request === 'object' ? request.compatibility : undefined }, 'Unsupported input')
  }))
  assert.deepEqual(requests, [64, { target: 64, compatibility: 'mp3' }])
  for (const abort of [false, true]) {
    const controller = new AbortController()
    let count = 0
    await assert.rejects(withRemoteCompatibility('original', controller.signal, async () => {
      count++
      if (abort) controller.abort()
      throw abort ? new RemoteCompatibilityFailure(original, 'Unsupported input') : new Error('Network failed')
    }))
    assert.equal(count, 1)
  }
})

test('a rejected original below the bitrate target tries Opus, and successful Opus stays pinned', async () => {
  const requests: unknown[] = []
  const result = await withRemoteCompatibility(128, new AbortController().signal, async request => {
    requests.push(request)
    if (typeof request !== 'object') throw new RemoteCompatibilityFailure({ ...original, requested: 128 }, 'Unsupported input')
    return { ...original, requested: request.target, requestedCodec: request.compatibility!, compatibility: request.compatibility }
  })
  assert.deepEqual(requests, [128, { target: 128, compatibility: 'opus' }])
  const pin = playbackQualityRequest(result)
  assert.deepEqual(pin, { target: 128, compatibility: 'opus' })
  assert.equal(isStreamingQualityRequest(pin), true)
  assert.notEqual(streamingRepresentation(128, 'opus'), streamingRepresentation(128))
  assert.notEqual(streamingRepresentation(128), 'mp3:128:v1')
})

test('Original stops at lossless when possible, otherwise accepts Opus before trying MP3', async () => {
  for (const supported of ['flac', 'opus'] as const) {
    const requests: unknown[] = []
    await withRemoteCompatibility('original', new AbortController().signal, async request => {
      requests.push(request)
      const compatibility = typeof request === 'object' ? request.compatibility : undefined
      if (compatibility === supported) return
      throw new RemoteCompatibilityFailure({ ...original, compatibility }, 'Unsupported input')
    })
    assert.equal(requests.length, supported === 'flac' ? 2 : 3)
    assert.deepEqual(requests.at(-1), { target: 'original', compatibility: supported })
  }
})
