// Real conventional cache + FFmpeg sessions alongside Stratum. Provider login /
// catalog are fixtures; this is not a test of each provider's HTTP protocol.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { RemoteAudioCache } from '../../src/main/services/remoteAudioCache.ts'
import { mainHarness } from './mainHarness.ts'
import type { StratumProofConfig } from '../../src/main/services/stratumProofConfig.ts'
import type { Track } from '../../src/renderer/types/audio.ts'
import type { RemoteStreamInfo } from '../../src/types/remoteStream.ts'

export type MixedRoute = 'stratum' | 'local' | 'progressive-local' | 'subsonic' | 'jellyfin' | 'plex'
export interface MixedConfig { directory: string; upstream: string; token: string; duration: number }
const execute = promisify(execFile)
export function mixedTrack(directory: string, route: MixedRoute, id: 'first' | 'second', duration: number): Track {
  const sourceType = route === 'stratum' ? 'subsonic' : route === 'progressive-local' ? 'local' : route
  return { id: `${route}-${id}`, path: sourceType === 'local' ? join(directory, `${id}.flac`)
    : `${sourceType}://${route === 'stratum' ? 7 : 8}/${id}`, sourceType, sourceId: route === 'stratum' ? 7 : 8,
    title: id === 'first' ? 'Safe Room' : 'What Are The Odds', artist: 'Alohaii', album: 'Patchwork',
    channels: 2, sampleRate: 48000, format: 'FLAC', duration }
}

export function mixedHarness(connection: StratumProofConfig, ffmpeg: string, config: MixedConfig,
  options: { deliver?: (channel: string, value: unknown) => void; recordPcm?: boolean; stratumQuality?: 'original' | 64 } = {}) {
  const cache = new RemoteAudioCache(join(config.directory, 'mixed-cache'), 128 * 1024 ** 2)
  const revisions = Object.fromEntries(['first', 'second'].map(id => [id,
    createHash('sha256').update(readFileSync(join(config.directory, `${id}.flac`))).digest('hex')]))
  const acquisitions: string[] = [], starts: Array<{ path: string; transport?: string; sourceType: string; sessionId: number }> = []
  const decodedLocal: string[] = []
  const infos: RemoteStreamInfo[] = []
  const h = mainHarness(connection, ffmpeg, { ...options, duration: () => config.duration,
    acquire: async (path, signal) => {
      const match = /^(subsonic|jellyfin|plex):\/\/8\/(first|second)$/.exec(path)
      assert.ok(match, 'Only explicit conventional fixture tracks may reach the test cache.')
      acquisitions.push(path)
      const lease = await cache.acquire({ provider: match[1], account: 'isolated-mixed-fixture', track: match[2],
        representation: 'original', revision: revisions[match[2]], open: signal => fetch(`${config.upstream}/rest/stream.view`, {
          method: 'POST', body: new URLSearchParams({ u: 'listener', t: config.token, id: match[2] }), signal
        }) }, signal)
      lease.quality = { requested: 'original', requestedCodec: null, delivered: null }
      return lease
    } })
  return { ...h, cache, starts, infos, acquisitions, decodedLocal,
    startOptions: async (path: string, rate: number, channels: number | null, options: Record<string, unknown> = {}) => {
      const info = await h.startOptions(path, rate, channels, { ...options,
        streamingQuality: options.streamingQuality ?? (path.startsWith('subsonic://7/') ? optionsForStratum() : 'original') })
      starts.push({ path, transport: info.transport, sourceType: info.sourceType, sessionId: info.sessionId })
      infos.push(info)
      return info
    },
    decodeLocal: async (path: string, rate: number, startTimeSeconds = 0) => {
      assert.ok(['first', 'second'].some(id => path === join(config.directory, `${id}.flac`)), 'Unknown fixture file.')
      decodedLocal.push(path)
      const { stdout } = await execute(ffmpeg, ['-v', 'error', '-nostdin',
        ...(startTimeSeconds > 0 ? ['-ss', String(startTimeSeconds)] : []), '-i', path, '-map', '0:a:0',
        '-f', 'f32le', '-ar', String(rate), '-ac', '2', 'pipe:1'], { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 ** 2 })
      return { sampleRate: rate, channels: 2, frames: stdout.length / 8, pcmByteLength: stdout.length,
        interleavedPcm: new Uint8Array(stdout).buffer }
    },
    close: async () => { await h.close(); await cache.close() }
  }
  function optionsForStratum() { return options.stratumQuality ?? 'original' }
}
