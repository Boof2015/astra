import { isAutomaticStreamingQuality, type StreamingQualityRequest } from '../../types/streamingQuality.ts'
import { parseSubsonicTrackPath } from './subsonic.ts'
import { validateStratumProofConnection, type StratumProofConnection, type StratumProofQuality } from './stratumProofClient.ts'

export interface StratumProofConfig extends StratumProofConnection { sourceId: number; tracks: string[] }

/** Explicit allowlist prevents this experiment from intercepting unrelated tracks.
 * The file contains only a disposable Sidecar bearer, never a Navidrome password. */
export function parseStratumProofConfig(text: string): StratumProofConfig {
  try {
    if (Buffer.byteLength(text) > 8192) throw new Error()
    const value = JSON.parse(text) as StratumProofConfig & { experiment: string }
    if (value.experiment !== 'astra-stratum-standard-proof-1' || !Number.isSafeInteger(value.sourceId) || value.sourceId < 1
      || !Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > 16
      || !value.tracks.every(track => typeof track === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(track))) throw new Error()
    return { ...validateStratumProofConnection(value), sourceId: value.sourceId, tracks: [...value.tracks] }
  } catch { throw new Error('Invalid disposable Stratum proof configuration.') }
}

export function stratumProofRoute(config: StratumProofConfig | null, path: string, quality: StreamingQualityRequest) {
  const track = parseSubsonicTrackPath(path)
  if (!config || !track || track.sourceId !== config.sourceId || !config.tracks.includes(track.sourceTrackId)) return null
  // The proof service exposes only this ladder. Unsupported manual requests
  // and compatibility conversions retain the conventional route.
  const mode = typeof quality === 'object' ? quality.mode : isAutomaticStreamingQuality(quality) ? quality : undefined
  const target = typeof quality === 'object' ? quality.target : mode ? 'original' : quality
  if (typeof quality === 'object' && quality.compatibility) return null
  const representation: StratumProofQuality | null = target === 'original' ? 'lossless'
    : target === 64 ? 'opus-64' : target === 128 ? 'opus-128' : null
  return representation ? { connection: config, track: track.sourceTrackId, quality: representation, mode, pinInitial: typeof quality === 'object' } : null
}
