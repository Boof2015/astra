import type { LyricsLine, LyricsPayload } from '../../types/lyrics'

export function normalizeLyricsText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\r\n/g, '\n').trim()
  return normalized.length > 0 ? normalized : null
}

export function sanitizeSyncLines(raw: unknown): LyricsLine[] {
  if (!Array.isArray(raw)) return []

  const lines: LyricsLine[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { text?: unknown; timestamp?: unknown }
    if (typeof record.text !== 'string') continue
    const text = record.text.trim()
    if (!text) continue

    const timestampMs = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? Math.max(0, Math.floor(record.timestamp))
      : null
    if (timestampMs === null) continue

    lines.push({ timestampMs, text })
  }

  lines.sort((left, right) => left.timestampMs - right.timestampMs)
  return lines
}

export function parseLrcSyncedLines(lyricsText: string): LyricsLine[] {
  const out: LyricsLine[] = []
  const rows = lyricsText.split(/\r?\n/)

  for (const row of rows) {
    const timestampRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?]/g
    const timestamps: number[] = []
    let match: RegExpExecArray | null
    while ((match = timestampRegex.exec(row)) !== null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fractionRaw = match[3] ?? ''
      const fractionMs = fractionRaw.length === 3
        ? Number(fractionRaw)
        : fractionRaw.length === 2
          ? Number(fractionRaw) * 10
          : fractionRaw.length === 1
            ? Number(fractionRaw) * 100
            : 0
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(fractionMs)) continue
      timestamps.push((minutes * 60_000) + (seconds * 1_000) + fractionMs)
    }

    if (timestamps.length === 0) continue
    const text = row.replace(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?]/g, '').trim()
    if (!text) continue

    for (const timestampMs of timestamps) {
      out.push({
        timestampMs: Math.max(0, Math.floor(timestampMs)),
        text
      })
    }
  }

  out.sort((left, right) => left.timestampMs - right.timestampMs)
  return out
}

export function toPlainLyricsFromLines(lines: LyricsLine[]): string | null {
  if (lines.length === 0) return null
  return lines.map((line) => line.text).join('\n')
}

export function createLyricsPayload(
  source: LyricsPayload['source'],
  provider: LyricsPayload['provider'],
  plainLyrics: string | null,
  syncedLyrics: string | null,
  syncedLines: LyricsLine[]
): LyricsPayload | null {
  const normalizedPlain = normalizeLyricsText(plainLyrics)
  const normalizedSynced = normalizeLyricsText(syncedLyrics)
  const normalizedLines = syncedLines
    .map((line) => ({
      timestampMs: Math.max(0, Math.floor(line.timestampMs)),
      text: line.text.trim()
    }))
    .filter((line) => line.text.length > 0)
    .sort((left, right) => left.timestampMs - right.timestampMs)

  if (!normalizedPlain && !normalizedSynced && normalizedLines.length === 0) {
    return null
  }

  return {
    source,
    provider,
    plainLyrics: normalizedPlain ?? toPlainLyricsFromLines(normalizedLines),
    syncedLyrics: normalizedSynced ?? toPlainLyricsFromLines(normalizedLines),
    syncedLines: normalizedLines
  }
}

export function parseLyricsText(lyricsText: string, source: LyricsPayload['source']): LyricsPayload | null {
  const normalizedText = normalizeLyricsText(lyricsText)
  if (!normalizedText) return null

  const syncedLines = parseLrcSyncedLines(normalizedText)
  const hasSyncedLyrics = syncedLines.length > 0
  const syncedLyrics = hasSyncedLyrics ? normalizedText : null
  const plainLyrics = hasSyncedLyrics
    ? (toPlainLyricsFromLines(syncedLines) ?? normalizedText)
    : normalizedText

  return createLyricsPayload(source, null, plainLyrics, syncedLyrics, syncedLines)
}
