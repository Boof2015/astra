const DISCORD_SHORT_TITLE_PADDING = '\u200B'
const DISCORD_TRUNCATION_SUFFIX = '\u2026'

export function truncateDiscordField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 1) + DISCORD_TRUNCATION_SUFFIX
}

export function normalizeDiscordActivityDetails(title: string, maxLength: number): string | null {
  const normalized = title.trim()
  if (!normalized) return null

  const padded = normalized.length === 1
    ? `${normalized}${DISCORD_SHORT_TITLE_PADDING}`
    : normalized

  return truncateDiscordField(padded, maxLength)
}
