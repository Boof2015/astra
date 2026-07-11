// Cross-device track identity for desktop<->mobile LAN sync. Track paths never
// match across devices (desktop filesystem vs Android SAF content:// URIs), so
// favorites and playlist entries travel as normalized metadata keys and each
// side resolves them against its own library. Normalization mirrors library.ts
// normalizeKey (whitespace-collapse + locale lowercase).
// This file is ported verbatim to astra-mobile/src/shared/sync/identity.ts —
// keep the two copies identical.

export const TRACK_SYNC_KEY_SEPARATOR = '\u001f'

export function normalizeSyncKeyPart(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function buildTrackSyncKey(title: string, artist: string, album: string): string {
  return [
    normalizeSyncKeyPart(title),
    normalizeSyncKeyPart(artist),
    normalizeSyncKeyPart(album)
  ].join(TRACK_SYNC_KEY_SEPARATOR)
}
