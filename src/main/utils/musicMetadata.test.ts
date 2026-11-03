import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFfprobeAudioMetadata } from '../../shared/audio/ffprobeMetadata.ts'
import { musicMetadataFromFfprobe } from './musicMetadata.ts'

test('ffprobe fallback recovers MP4 tags and stream properties after primary parser failure', () => {
  const probe = parseFfprobeAudioMetadata(JSON.stringify({
    streams: [{ codec_type: 'audio', codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos',
      channels: 6, sample_rate: '48000', duration: '329.577542', bit_rate: '768000', bits_per_sample: 0 }],
    format: { tags: { TITLE: 'Test song', artist: 'Test artist', album: 'Test album', album_artist: 'Album artist',
      track: '10/14', disc: '1/2', date: '1991-11-26', genre: 'Pop', replaygain_track_gain: '-4.2 dB' } }
  }))!
  const metadata = musicMetadataFromFfprobe(probe)
  assert.equal(metadata.common.title, 'Test song')
  assert.equal(metadata.common.artist, 'Test artist')
  assert.equal(metadata.common.albumartist, 'Album artist')
  assert.equal(metadata.common.year, 1991)
  assert.deepEqual(metadata.common.track, { no: 10, of: 14 })
  assert.deepEqual(metadata.common.disk, { no: 1, of: 2 })
  assert.equal(metadata.format.duration, 329.577542)
  assert.equal(metadata.format.sampleRate, 48000)
  assert.equal(metadata.format.bitrate, 768000)
  assert.equal(metadata.format.bitsPerSample, undefined)
  assert.ok(metadata.native.ffprobe.some(tag => tag.id === 'replaygain_track_gain'))
})

test('missing and malformed fallback properties stay absent instead of becoming zero or NaN', () => {
  const probe = parseFfprobeAudioMetadata('{"streams":[{"codec_name":"aac","duration":"N/A"}],"format":{"tags":{"track":"bad/0","date":"bad"}}}')!
  const metadata = musicMetadataFromFfprobe(probe)
  assert.equal(metadata.format.duration, undefined)
  assert.equal(metadata.common.year, undefined)
  assert.deepEqual(metadata.common.track, { no: null, of: null })
})
