import { randomUUID } from 'node:crypto'
import { buildPlexTranscodeUrl, PlexRequestError, plexHeaders, plexJson, plexUrl, type PlexCredentials, type PlexFetch } from './plex'
import { streamingRepresentation, type RemoteCompatibilityCodec, type StreamQualityTarget } from '../../types/streamingQuality'
import type { RemoteAudioSource } from './remoteAudioCache'

export function createPlexAudioSource(options: {
  sourceId: number; accountId: string; serverId: string; libraryId: string; trackId: string; revision: string
  quality?: StreamQualityTarget; compatibility?: RemoteCompatibilityCodec
  credentials: (signal: AbortSignal, force: boolean) => Promise<PlexCredentials>
  fetch?: PlexFetch
}): RemoteAudioSource {
  const { sourceId, accountId, serverId, libraryId, trackId, revision, quality = 'original', compatibility } = options
  return { provider: 'plex', account: JSON.stringify([sourceId, accountId, serverId, libraryId]), track: trackId,
    representation: streamingRepresentation(quality, compatibility), revision,
    open: async signal => {
      for (const force of [false, true]) {
        signal.throwIfAborted()
        const credentials = await options.credentials(signal, force)
        try {
          let url: URL
          if (quality === 'original' && !compatibility) {
            const metadata = await plexJson(credentials, `/library/metadata/${encodeURIComponent(trackId)}`, { signal, fetch: options.fetch })
            const item = metadata.MediaContainer?.Metadata?.find((track: any) => String(track.ratingKey) === trackId && track.type === 'track')
            const parts = item?.Media?.[0]?.Part
            if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0].key !== 'string'
              || !/^\/library\/parts\/\d+\//.test(parts[0].key)) throw new Error('Plex did not provide a playable original audio file.')
            url = plexUrl(credentials.baseUrl, parts[0].key)
          } else url = buildPlexTranscodeUrl(credentials, trackId, quality, compatibility ?? 'opus', randomUUID())
          const response = await (options.fetch ?? fetch)(url, { signal, redirect: 'error', headers: { ...plexHeaders(credentials.account, credentials.server.token), 'Accept-Encoding': 'identity' } })
          if (![401, 498].includes(response.status) || force) return response
          await response.body?.cancel()
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof PlexRequestError && [401, 498].includes(error.status) && !force) continue
          if (error instanceof PlexRequestError) throw error
          throw new Error('Plex could not open this audio stream.')
        }
      }
      throw new Error('Plex sign-in expired. Reconnect this source.')
    }
  }
}
