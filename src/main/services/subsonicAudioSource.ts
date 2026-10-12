import { buildSubsonicStreamUrl, normalizeSubsonicBaseUrl, type SubsonicConnectionConfig } from './subsonic'
import { buildProviderRequestHeaders } from './providerClientIdentity'
import type { RemoteAudioSource } from './remoteAudioCache'
import { streamingRepresentation, type StreamQualityTarget, type RemoteCompatibilityCodec } from '../../types/streamingQuality'

export function createSubsonicAudioSource(options: {
  sourceId: number; connection: SubsonicConnectionConfig; trackId: string; revision: string; quality?: StreamQualityTarget; compatibility?: RemoteCompatibilityCodec
}): RemoteAudioSource {
  const { sourceId, connection, trackId, revision, quality = 'original', compatibility } = options
  return {
    provider: 'subsonic', account: JSON.stringify([sourceId, normalizeSubsonicBaseUrl(connection.baseUrl), connection.username]),
    track: trackId, representation: streamingRepresentation(quality, compatibility), revision,
    open: signal => fetch(buildSubsonicStreamUrl(connection, trackId, compatibility
      ? { format: compatibility, maxBitRateKbps: compatibility === 'flac' ? 0 : quality === 'original' ? 320 : quality }
      : quality === 'original'
      ? { original: true } : { format: 'mp3', maxBitRateKbps: quality }), {
      signal, headers: { ...buildProviderRequestHeaders(), 'Accept-Encoding': 'identity' }
    })
  }
}
