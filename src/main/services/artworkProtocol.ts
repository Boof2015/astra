import { parseSubsonicArtworkHash } from './subsonic'

// Local artwork references are joined to one of the artwork cache directories.
// Keep this allowlist deliberately narrow so a protocol URL cannot escape those
// directories or address an unrelated file.
const LOCAL_ARTWORK_HASH_PATTERN = /^(?:plc:|ari:)?[A-Za-z0-9][A-Za-z0-9._ -]*$/

export function isAllowedArtworkProtocolHash(hash: string): boolean {
  if (parseSubsonicArtworkHash(hash)) {
    // Subsonic references are resolved to cached, content-addressed hashes
    // before library.getArtworkPath is called.
    return true
  }

  return LOCAL_ARTWORK_HASH_PATTERN.test(hash) && !hash.includes('..')
}
