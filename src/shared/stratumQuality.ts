/** Ordered by fidelity; keep encoded representations distinct in caches/readouts. */
export const STRATUM_QUALITIES = ['opus-64', 'opus-128', 'opus-192', 'opus-256', 'opus-320', 'lossless'] as const
export type StratumQuality = typeof STRATUM_QUALITIES[number]
export const LEGACY_STRATUM_QUALITIES: readonly StratumQuality[] = ['opus-64', 'opus-128', 'lossless']
export const STRATUM_OPUS_KBPS = { 'opus-64': 64, 'opus-128': 128, 'opus-192': 192, 'opus-256': 256, 'opus-320': 320 } as const
export const isStratumQuality = (value: unknown): value is StratumQuality =>
  typeof value === 'string' && (STRATUM_QUALITIES as readonly string[]).includes(value)

/** Old services omit the field. Unknown future representations are not requested. */
export function advertisedStratumQualities(value: unknown): readonly StratumQuality[] {
  if (value === undefined) return LEGACY_STRATUM_QUALITIES
  if (!Array.isArray(value) || !value.length || value.length > 32
    || !value.every(item => typeof item === 'string' && item.length <= 64)) {
    throw new Error('Invalid Stratum quality capabilities.')
  }
  const known = STRATUM_QUALITIES.filter(quality => value.includes(quality))
  if (!known.length) throw new Error('Sidecar offers no supported Stratum quality.')
  return known
}
