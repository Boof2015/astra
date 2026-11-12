import assert from 'node:assert/strict'
import test from 'node:test'
import { StratumProofClient, type StratumProofAuthentication } from './stratumProofClient.ts'
import { advertisedStratumQualities, STRATUM_QUALITIES, LEGACY_STRATUM_QUALITIES } from '../../shared/stratumQuality.ts'
import { STRATUM_MAX_SOURCE_SECONDS } from '../../shared/stratumSource.ts'
import { stratumOutputInterval } from './stratumProofPlayback.ts'

test('capability parsing accepts known subsets, ignores future encodes and treats omission as legacy', () => {
  assert.deepEqual(advertisedStratumQualities(undefined), LEGACY_STRATUM_QUALITIES)
  assert.deepEqual(advertisedStratumQualities(['future', 'opus-256', 'lossless', 'opus-64', 'opus-256']), ['opus-64', 'opus-256', 'lossless'])
  for (const malformed of [null, [], ['unknown-only'], [64], 'opus-320']) assert.throws(() => advertisedStratumQualities(malformed))
})

test('client negotiates before staging, never sends unsupported qualities, and shares connection evidence', async () => {
  let offered: unknown = undefined
  const calls: string[] = []
  const connection: StratumProofAuthentication = {
    endpoint: 'https://sidecar.test', signal: new AbortController().signal, getBearer: async () => 'fixture', reject() {},
    request: async (path, method) => {
      calls.push(`${method} ${path}`)
      const value = path.endsWith('capabilities') ? { protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1', qualities: offered }
        : { playback: 'a'.repeat(64), sourcePolicy: 'complete-private-copy', maxSegmentSeconds: 4,
          source: { sha256: 'b'.repeat(64), sample_rate: 48000, channels: 2, bits_per_sample: 24, frames: 480000, codec: 'flac' } }
      return { type: 'application/json', bytes: Buffer.from(JSON.stringify(value)) }
    }
  }
  const signal = new AbortController().signal, client = new StratumProofClient(connection)
  await assert.rejects(client.open('track', signal, 'opus-320'), /does not offer/)
  assert.deepEqual(calls, ['GET /access/v1/capabilities'], 'unsupported Fixed must not stage the source')
  const old = await client.open('track', signal, 'opus-128')
  const before = calls.length
  await assert.rejects(client.segmentResponse(old, 0, 48000, 'opus-192', signal), /does not offer/)
  assert.equal(calls.length, before, 'unsupported segment must not leave the client')
  offered = STRATUM_QUALITIES
  const newer = await client.open('track', signal, 'opus-320')
  assert.deepEqual(newer.qualities, STRATUM_QUALITIES)
  assert.deepEqual(new StratumProofClient(connection).qualities, STRATUM_QUALITIES)
  await assert.rejects(client.segmentResponse(old, 0, 48000, 'opus-320', signal), /does not offer/, 'old handle keeps its negotiated contract')
  const other = new StratumProofClient({ ...connection })
  assert.deepEqual(other.qualities, LEGACY_STRATUM_QUALITIES, 'another connection must not inherit the ladder')
})

test('long sources keep exact frame arithmetic beyond signed 32-bit and reject beyond the duration bound', async () => {
  const maximum = 96000 * STRATUM_MAX_SOURCE_SECONDS
  assert.ok(maximum > 2 ** 31)
  let frames = maximum, closes = 0
  const connection: StratumProofAuthentication = {
    endpoint: 'https://sidecar.test', signal: new AbortController().signal, getBearer: async () => 'fixture', reject() {},
    request: async (path, method) => {
      if (method === 'DELETE') closes++
      const value = path.endsWith('capabilities') ? { protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1' }
        : { playback: 'a'.repeat(64), sourcePolicy: 'complete-private-copy', maxSegmentSeconds: 4,
          source: { sha256: 'b'.repeat(64), sample_rate: 96000, channels: 2, bits_per_sample: 24, frames, codec: 'flac' } }
      return { type: 'application/json', bytes: Buffer.from(JSON.stringify(value)) }
    }
  }
  const client = new StratumProofClient(connection), signal = new AbortController().signal
  const playback = await client.open('long', signal)
  assert.equal(playback.source.frames, maximum)
  const interval = stratumOutputInterval(playback.source, 48000, STRATUM_MAX_SOURCE_SECONDS - 1)
  assert.equal(interval.origin, maximum - 96000)
  assert.equal(interval.frames, 48000)
  frames++
  await assert.rejects(client.open('too-long', signal), /Invalid Stratum/)
  assert.equal(closes, 1, 'an invalid prepared source releases its server slot')
})
