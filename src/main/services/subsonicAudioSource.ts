import { buildSubsonicStreamUrl, normalizeSubsonicBaseUrl, type SubsonicConnectionConfig } from './subsonic'
import { buildProviderRequestHeaders } from './providerClientIdentity'
import type { RemoteAudioSource } from './remoteAudioCache'
import { streamingRepresentation, type StreamingQuality } from '../../types/streamingQuality'

export function createSubsonicAudioSource(options: {
  sourceId: number; connection: SubsonicConnectionConfig; trackId: string; revision: string; quality?: StreamingQuality
}): RemoteAudioSource {
  const { sourceId, connection, trackId, revision, quality = 'original' } = options
  return {
    provider: 'subsonic', account: JSON.stringify([sourceId, normalizeSubsonicBaseUrl(connection.baseUrl), connection.username]),
    track: trackId, representation: streamingRepresentation(quality), revision,
    open: signal => fetch(buildSubsonicStreamUrl(connection, trackId, quality === 'original'
      ? { original: true } : { format: 'mp3', maxBitRateKbps: quality }), {
      signal, headers: { ...buildProviderRequestHeaders(), 'Accept-Encoding': 'identity' }
    })
  }
}
