import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { StratumProofClient, validateStratumProofConnection } from './stratumProofClient.ts'
import { parseStratumProofConfig, stratumProofRoute } from './stratumProofConfig.ts'
import { stratumOutputInterval } from './stratumProofPlayback.ts'

const connection = { endpoint: 'http://127.0.0.1:1234', session: 'a'.repeat(64) }
const source = { sha256: 'b'.repeat(64), sample_rate: 44100, channels: 2, bits_per_sample: 24, frames: 441000 }
const playback = { playback: 'c'.repeat(64), source }
const config = { experiment: 'astra-stratum-standard-proof-1', ...connection, sourceId: 7, tracks: ['song'] }

test('Stratum proof cannot forward a bearer outside literal loopback or accept credential URLs', () => {
  for (const endpoint of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://192.168.1.1:1234',
    'http://user:secret@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?token=x']) {
    assert.throws(() => validateStratumProofConnection({ ...connection, endpoint }))
  }
  assert.equal(validateStratumProofConnection(connection).endpoint, connection.endpoint)
})

test('Stratum development route is restricted to allowlisted Navidrome tracks and proven quality choices', () => {
  const parsed = parseStratumProofConfig(JSON.stringify(config))
  for (const path of ['/song.flac', 'jellyfin://7/song', 'plex://7/song', 'subsonic://8/song', 'subsonic://7/another']) {
    assert.equal(stratumProofRoute(parsed, path, 'original'), null)
  }
  for (const quality of [192, 256, 320, { mode: 'automatic', target: 192 },
    { target: 'original', compatibility: 'flac' }] as const) assert.equal(stratumProofRoute(parsed, 'subsonic://7/song', quality), null)
  for (const [quality, expected] of [['original', 'lossless'], [64, 'opus-64'], [128, 'opus-128']] as const) {
    assert.equal(stratumProofRoute(parsed, 'subsonic://7/song', quality)?.quality, expected)
  }
  for (const mode of ['automatic', 'automatic-original'] as const) {
    assert.equal(stratumProofRoute(parsed, 'subsonic://7/song', mode)?.mode, mode)
    assert.equal(stratumProofRoute(parsed, 'subsonic://7/song', { mode, target: 64 })?.quality, 'opus-64')
  }
  assert.equal(stratumProofRoute(null, 'subsonic://7/song', 'original'), null)
  assert.throws(() => parseStratumProofConfig(JSON.stringify({ ...config, tracks: ['../credentials'] })))
})

test('seek conversion stays phase-anchored and uses one interval through EOF', () => {
  const value = stratumOutputInterval(source, 48000, 1.234567)
  assert.equal(value.begin % 147, 0)
  assert.equal(value.frames, Math.floor((source.frames - value.origin) * 48000 / 44100))
  assert.ok(value.origin - value.begin >= .12 * 44100)
  assert.equal(stratumOutputInterval(source, 44100, 1.234567).begin, value.origin)
  assert.throws(() => stratumOutputInterval(source, 48000, 10))
  assert.throws(() => stratumOutputInterval(source, Infinity, 0))
})

test('segment delivery validates identity, native trims and payload before decoding; redirects never receive a bearer', async t => {
  const payload = Buffer.from('encoded fixture')
  const metadata = { experiment: 'stratum-audio-poc-2', source_sha256: source.sha256, encoder: 'd'.repeat(64),
    quality: 'lossless', sample_rate: 44100, codec_sample_rate: 44100, codec_decoded_frames: 1000,
    channels: 2, presentation: { start: 200, frames: 500 }, encoded_interval: { start: 0, frames: 1000 },
    decoded_frames: 1000, discard_start_frames: 200, discard_end_frames: 300, resample_tail_frames: 0,
    codec_preskip_frames: 0, source_bytes_preserved: false, source_pcm_preserved: true,
    payload_bytes: payload.length, payload_sha256: createHash('sha256').update(payload).digest('hex') }
  let change: Record<string, unknown> = {}
  let status = 200
  let count = 0
  const server = createServer((req, res) => {
    count++
    assert.equal(req.headers.authorization, `Bearer ${connection.session}`)
    assert.equal(req.url?.includes(connection.session), false)
    req.resume()
    const encoded = Buffer.from(JSON.stringify({ ...metadata, ...change }))
    const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length)
    res.writeHead(status, { 'content-type': 'application/vnd.stratum.segment', location: '/redirect-target' })
    res.end(Buffer.concat([length, encoded, payload]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const client = new StratumProofClient({ ...connection, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const request = () => client.segment(playback, 200, 500, 'lossless', AbortSignal.timeout(2000))
  assert.deepEqual((await request()).payload, payload)
  for (const invalid of [{ source_sha256: 'e'.repeat(64) }, { sample_rate: 48000 }, { presentation: { start: 201, frames: 500 } },
    { decoded_frames: 999 }, { discard_end_frames: 299 }, { payload_sha256: 'f'.repeat(64) }, { quality: 'opus-64' }]) {
    change = invalid
    await assert.rejects(request(), /Invalid Stratum/)
  }
  change = {}; status = 302
  const before = count
  await assert.rejects(request(), /HTTP 302/)
  assert.equal(count, before + 1)
  status = 401
  await assert.rejects(request(), /sign-in expired/)
})
