export interface ArtistNameToken {
  artist: string
  separator: string | null
}

export function normalizeArtistName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

export function normalizeArtistNames(values: readonly unknown[] | null | undefined): string[] {
  if (!values) return []

  const unique = new Map<string, string>()
  for (const value of values) {
    const display = normalizeArtistName(value)
    if (!display) continue
    const key = display.toLocaleLowerCase()
    if (!key || unique.has(key)) continue
    unique.set(key, display)
  }

  return Array.from(unique.values())
}

export function serializeArtistNames(names: readonly unknown[] | null | undefined): string | null {
  const normalized = normalizeArtistNames(names)
  return normalized.length > 0 ? JSON.stringify(normalized) : null
}

export function deserializeArtistNames(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? normalizeArtistNames(parsed) : []
  } catch {
    return []
  }
}

export function formatArtistNames(names: readonly unknown[] | null | undefined): string {
  const normalized = normalizeArtistNames(names)
  if (normalized.length === 0) return ''
  if (normalized.length === 1) return normalized[0]
  if (normalized.length === 2) return `${normalized[0]} & ${normalized[1]}`
  return `${normalized.slice(0, -1).join(', ')} & ${normalized[normalized.length - 1]}`
}

export function buildArtistNameTokens(names: readonly unknown[] | null | undefined): ArtistNameToken[] {
  const normalized = normalizeArtistNames(names)
  return normalized.map((artist, index) => {
    let separator: string | null = null
    if (index < normalized.length - 2) {
      separator = ', '
    } else if (index === normalized.length - 2) {
      separator = ' & '
    }
    return { artist, separator }
  })
}
