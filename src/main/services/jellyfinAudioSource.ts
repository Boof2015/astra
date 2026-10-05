import {
  buildJellyfinOriginalStreamUrl,
  buildJellyfinQualityStreamUrl,
  buildJellyfinStreamRequestHeaders,
  normalizeJellyfinBaseUrl,
  type JellyfinAuthContext,
  type JellyfinConnectionConfig
} from './jellyfin'
import type { RemoteAudioSource } from './remoteAudioCache'
import { streamingRepresentation, type StreamingQuality } from '../../types/streamingQuality'

/** Resolve auth only on a cache miss. Tokens are neither cache identity nor decoder input. */
export function createJellyfinAudioSource(options: {
  sourceId: number
  connection: JellyfinConnectionConfig
  trackId: string
  revision: string
  quality?: StreamingQuality
  authenticate: (signal: AbortSignal, forceRefresh: boolean) => Promise<JellyfinAuthContext>
}): RemoteAudioSource {
  const { sourceId, connection, trackId, revision, authenticate, quality = 'original' } = options
  return {
    provider: 'jellyfin',
    account: JSON.stringify([sourceId, normalizeJellyfinBaseUrl(connection.baseUrl), connection.username]),
    track: trackId,
    representation: streamingRepresentation(quality),
    revision,
    open: async signal => {
      for (const forceRefresh of [false, true]) {
        signal.throwIfAborted()
        const auth = await authenticate(signal, forceRefresh)
        signal.throwIfAborted()
        const response = await fetch(quality === 'original'
          ? buildJellyfinOriginalStreamUrl(connection, trackId)
          : buildJellyfinQualityStreamUrl(connection, trackId, quality), {
          signal,
          headers: { ...buildJellyfinStreamRequestHeaders(connection, auth), 'Accept-Encoding': 'identity' }
        })
        if (response.status !== 401 || forceRefresh) return response
        await response.body?.cancel()
      }
      throw new Error('Jellyfin authentication failed.')
    }
  }
}
