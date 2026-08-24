// Stream IDs are transport identities, not track metadata. Keep them short and opaque so a
// filesystem path in Track.id can never push the ID past an existing receiver's 128-character
// wire limit. The track identity still travels separately in ParallaxStreamInfo.trackId.
export function createParallaxStreamId(
  createdAtMs: number = Date.now(),
  entropy: number = Math.random()
): string {
  const timestamp = Number.isSafeInteger(createdAtMs) && createdAtMs >= 0
    ? createdAtMs
    : Date.now()
  const normalizedEntropy = Number.isFinite(entropy) ? Math.abs(entropy % 1) : Math.random()
  const entropyInteger = Math.floor(normalizedEntropy * (Number.MAX_SAFE_INTEGER + 1))
  return `px-${timestamp.toString(36)}-${entropyInteger.toString(36).padStart(11, '0')}`
}
