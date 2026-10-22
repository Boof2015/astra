import { net } from 'electron'
import type { PlexRequestOptions } from './plex'

// Plex's secure LAN certificate chain can validate in Chromium while Node's
// bundled CA lookup rejects it. Use the same validating transport for discovery,
// metadata, reporting and audio; never disable certificate verification.
// Retained audio is cached by RemoteAudioCache, not the browser HTTP cache.
export const plexRequestOptions: PlexRequestOptions & { fetch: NonNullable<PlexRequestOptions['fetch']> } = {
  fetch: (url, init) => net.fetch(url.toString(), { ...init, cache: 'no-store', credentials: 'omit' })
}
