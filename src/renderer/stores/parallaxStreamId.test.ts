import test from 'node:test'
import assert from 'node:assert/strict'
import { parseParallaxStreamInfo } from '../../types/parallax.ts'
import { createParallaxStreamId } from './parallaxStreamId.ts'

test('host stream IDs stay compatible with existing receivers for long local track paths', () => {
  const trackId = '/Users/landerhartel/Music/msyucs/easy download for new stuff/61. Haywyre, Molly Moore - Use My Love.flac'
  const legacyStreamId = `1786987487871-5gbzn1l4h3-${trackId}`
  assert.ok(legacyStreamId.length > 128)

  const streamId = createParallaxStreamId(1_786_987_487_871, 0.5)
  assert.ok(streamId.length <= 128)
  assert.notEqual(streamId, createParallaxStreamId(1_786_987_487_871, 0.75))
  assert.ok(parseParallaxStreamInfo({
    streamId,
    trackId,
    title: 'Use My Love',
    artist: 'Haywyre, Molly Moore',
    album: 'Use My Love',
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: 195.48375,
    totalFrames: 9_383_220,
    chunkFrames: 4096,
    groupLatencyMs: 1000,
    createdAt: 1_786_987_487_871
  }))
})
