export interface ArtistToken {
  artist: string
  separator: string | null
}

const SEPARATOR_SPLIT_PATTERN = /([,;])/

function normalizeArtistText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function parseArtistMetadata(artistText: string): ArtistToken[] {
  const normalized = normalizeArtistText(artistText)
  if (!normalized) return []

  const parts = normalized.split(SEPARATOR_SPLIT_PATTERN)
  const tokens: ArtistToken[] = []
  let pendingSeparator: ',' | ';' | null = null

  for (const part of parts) {
    if (part === ',' || part === ';') {
      pendingSeparator = part
      continue
    }

    const artist = normalizeArtistText(part)
    if (!artist) continue

    if (pendingSeparator && tokens.length > 0) {
      tokens[tokens.length - 1].separator = `${pendingSeparator} `
    }

    tokens.push({ artist, separator: null })
    pendingSeparator = null
  }

  if (tokens.length === 0) {
    return [{ artist: normalized, separator: null }]
  }

  return tokens
}
