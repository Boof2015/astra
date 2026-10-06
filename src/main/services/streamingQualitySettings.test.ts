import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamingQualityPreferences } from './streamingQualitySettings.ts'
import { deliveredAudioFormat, parseStreamingQualitySettings, qualityRequestForTrack, resolveStreamingQuality, streamingRepresentation } from '../../types/streamingQuality.ts'

const navi = { provider: 'subsonic' as const, sourceId: 7 }
const jelly = { provider: 'jellyfin' as const, sourceId: 7 }

test('manual limits preserve already smaller lossy originals without guessing for unknown metadata', () => {
  assert.equal(qualityRequestForTrack(320, { codec: 'aac', bitrate: 256 }), 'original')
  assert.equal(qualityRequestForTrack(128, { codec: 'aac', bitrate: 256 }), 128)
  assert.equal(qualityRequestForTrack(320, { codec: 'mp3', bitrate: null }), 320)
  assert.equal(qualityRequestForTrack(320, { codec: 'flac', bitrate: 200 }), 320)
  assert.equal(qualityRequestForTrack('original', { codec: 'flac', bitrate: 3000 }), 'original')
})

test('new and corrupt preferences preserve Original; invalid overrides do not become active', () => {
  for (const value of [undefined, null, '', 'bad', 'null', '{"global":"auto"}']) {
    assert.equal(resolveStreamingQuality(parseStreamingQualitySettings(value), navi), 'original')
  }
  const settings = parseStreamingQualitySettings(JSON.stringify({ global: 192, overrides: {
    'subsonic:7': 128, 'jellyfin:7': 'original', 'jellyfin:8': 99, 'local:1': 64, '__proto__': 64
  } }))
  assert.deepEqual(settings, { global: 192, overrides: { 'subsonic:7': 128, 'jellyfin:7': 'original' } })
  assert.equal(resolveStreamingQuality(settings, navi), 128)
  assert.equal(resolveStreamingQuality(settings, jelly), 'original')
  assert.equal(resolveStreamingQuality(settings, { ...navi, sourceId: 8 }), 192)
})

test('persisted global and per-server edits serialize, inherit explicitly, and survive service recreation', async () => {
  let saved: string | null = null
  let writes = 0
  const notifications: unknown[] = []
  const storage = { read: () => saved, write: async (value: string) => {
    await new Promise(resolve => setImmediate(resolve)); saved = value; writes++
  }, sourceExists: () => true, changed: (value: unknown) => notifications.push(value) }
  const service = new StreamingQualityPreferences(storage)
  await Promise.all([service.update(128), service.update(320, navi), service.update('original', jelly)])
  assert.deepEqual(service.read(), { global: 128, overrides: { 'subsonic:7': 320, 'jellyfin:7': 'original' } })
  const reopened = new StreamingQualityPreferences(storage)
  await reopened.update(64)
  assert.equal(resolveStreamingQuality(reopened.read(), navi), 320)
  await reopened.update(null, navi)
  assert.equal(resolveStreamingQuality(reopened.read(), navi), 64)
  assert.equal(resolveStreamingQuality(reopened.read(), jelly), 'original')
  assert.equal(writes, 5)
  assert.equal(notifications.length, writes)
})

test('invalid inputs, missing servers and failed writes leave preferences intact and do not announce a change', async () => {
  const service = new StreamingQualityPreferences({ read: () => '{"global":256}',
    write: async () => { throw new Error('Disk full') }, sourceExists: () => false,
    changed: () => assert.fail('Must only notify after persistence') })
  for (const value of [65, '128', null, {}, 'automatic-invalid']) {
    await assert.rejects(service.update(value as never), /Invalid streaming quality/)
  }
  await assert.rejects(service.update(128, navi), /no longer exists/)
  await assert.rejects(service.update(128, { ...navi, sourceId: NaN }), /Invalid streaming server/)
  await assert.rejects(service.update(128), /Disk full/)
  assert.equal(service.read().global, 256)
})

test('representations keep original cache compatibility and separate each manual target', () => {
  assert.equal(streamingRepresentation('original'), 'original')
  assert.equal(new Set(['original', 64, 128, 192, 256, 320].map(value => streamingRepresentation(value as never))).size, 6)
})

test('delivered format uses probe evidence, including server responses that ignore the requested conversion', () => {
  assert.deepEqual(deliveredAudioFormat({ streams: [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '96000',
    channels: 2, bits_per_raw_sample: '24', bit_rate: 'N/A' }] }), {
    codec: 'flac', sampleRate: 96000, channels: 2, bitDepth: 24, bitrateKbps: null
  })
  assert.equal(deliveredAudioFormat({ streams: [] }), null)
  assert.equal(deliveredAudioFormat({ streams: [{ codec_type: 'audio', codec_name: 'mp3', bit_rate: '128000' }] })?.bitrateKbps, 128)
})
