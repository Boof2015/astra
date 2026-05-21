import { parseXLRC } from '@boof2015/xlrc'
import type {
  LyricsFormat,
  LyricsFurigana,
  LyricsLine,
  LyricsPayload,
  LyricsTranslation,
  LyricsWord
} from '../../types/lyrics'

const LRC_TIMESTAMP_REGEX = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?]/g
const LRC_OFFSET_REGEX = /^\[offset:([+-]?\d+)]\s*$/i
const ENHANCED_LRC_WORD_TIMESTAMP_REGEX = /<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g

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

    const timestampMs = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? Math.max(0, Math.floor(record.timestamp))
      : null
    if (timestampMs === null) continue

    lines.push(text
      ? { timestampMs, text }
      : { timestampMs, text: '', kind: 'silence' }
    )
  }

  lines.sort((left, right) => left.timestampMs - right.timestampMs)
  return lines
}

function normalizeTimestampMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null
}

function sanitizeFurigana(raw: unknown, text: string): LyricsFurigana[] {
  if (!Array.isArray(raw)) return []

  const furigana: LyricsFurigana[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { start?: unknown; end?: unknown; base?: unknown; reading?: unknown }
    if (typeof record.base !== 'string' || typeof record.reading !== 'string') continue
    if (typeof record.start !== 'number' || typeof record.end !== 'number') continue
    if (!Number.isInteger(record.start) || !Number.isInteger(record.end)) continue
    const start = record.start
    const end = record.end
    if (start < 0 || end <= start || end > text.length) continue
    const base = record.base.trim()
    const reading = record.reading.trim()
    if (!base || !reading) continue

    furigana.push({ start, end, base, reading })
  }

  return furigana
}

function sanitizeWords(raw: unknown): LyricsWord[] {
  if (!Array.isArray(raw)) return []

  const words: LyricsWord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { timestampMs?: unknown; timestamp?: unknown; text?: unknown; furigana?: unknown }
    if (typeof record.text !== 'string') continue
    const timestampMs = normalizeTimestampMs(record.timestampMs ?? record.timestamp)
    if (timestampMs === null) continue
    const text = record.text.trim()
    if (!text) continue
    const furigana = sanitizeFurigana(record.furigana, text)

    words.push({
      timestampMs,
      text,
      ...(furigana.length > 0 ? { furigana } : {})
    })
  }

  return words
}

function sanitizeTranslations(raw: unknown): LyricsTranslation[] {
  if (!Array.isArray(raw)) return []

  const translations: LyricsTranslation[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { lang?: unknown; text?: unknown }
    if (typeof record.lang !== 'string' || typeof record.text !== 'string') continue
    const lang = record.lang.trim()
    const text = record.text.trim()
    if (!lang || !text) continue
    translations.push({ lang, text })
  }

  return translations
}

export function sanitizeLyricsLines(rawValue: unknown): LyricsLine[] {
  if (!Array.isArray(rawValue)) return []

  const lines: LyricsLine[] = []
  for (const entry of rawValue) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as {
      timestampMs?: unknown
      text?: unknown
      kind?: unknown
      words?: unknown
      furigana?: unknown
      translations?: unknown
      voice?: unknown
    }
    if (typeof record.text !== 'string') continue

    const timestampMs = normalizeTimestampMs(record.timestampMs)
    if (timestampMs === null) continue

    if (record.kind === 'silence') {
      lines.push({ timestampMs, text: '', kind: 'silence' })
      continue
    }

    const text = record.text.trim()
    if (!text) continue

    const words = sanitizeWords(record.words)
    const furigana = sanitizeFurigana(record.furigana, text)
    const translations = sanitizeTranslations(record.translations)
    const voice = typeof record.voice === 'string' && record.voice.trim()
      ? record.voice.trim()
      : null

    lines.push({
      timestampMs,
      text,
      ...(words.length > 0 ? { words } : {}),
      ...(furigana.length > 0 ? { furigana } : {}),
      ...(translations.length > 0 ? { translations } : {}),
      ...(voice ? { voice } : {})
    })
  }

  lines.sort((left, right) => left.timestampMs - right.timestampMs)
  return lines
}

function parseLrcOffsetMs(rows: string[]): number {
  for (const row of rows) {
    const match = row.trim().match(LRC_OFFSET_REGEX)
    if (!match) continue
    const offset = Number.parseInt(match[1], 10)
    return Number.isFinite(offset) ? offset : 0
  }

  return 0
}

function stripEnhancedLrcWordTimestamps(value: string): string {
  return value.replace(ENHANCED_LRC_WORD_TIMESTAMP_REGEX, '')
}

export function parseLrcSyncedLines(lyricsText: string): LyricsLine[] {
  const out: LyricsLine[] = []
  const rows = lyricsText.split(/\r?\n/)
  const offsetMs = parseLrcOffsetMs(rows)

  for (const row of rows) {
    const timestampRegex = new RegExp(LRC_TIMESTAMP_REGEX)
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
      timestamps.push((minutes * 60_000) + (seconds * 1_000) + fractionMs + offsetMs)
    }

    if (timestamps.length === 0) continue
    const text = stripEnhancedLrcWordTimestamps(
      row.replace(LRC_TIMESTAMP_REGEX, '')
    ).trim()

    for (const timestampMs of timestamps) {
      out.push(text
        ? {
            timestampMs: Math.max(0, Math.floor(timestampMs)),
            text
          }
        : {
            timestampMs: Math.max(0, Math.floor(timestampMs)),
            text: '',
            kind: 'silence'
          }
      )
    }
  }

  out.sort((left, right) => left.timestampMs - right.timestampMs)
  return out
}

export function toPlainLyricsFromLines(lines: LyricsLine[]): string | null {
  const textLines = lines
    .filter((line) => line.kind !== 'silence' && line.text.trim().length > 0)
    .map((line) => line.text)
  if (textLines.length === 0) return null
  return textLines.join('\n')
}

export function createLyricsPayload(
  source: LyricsPayload['source'],
  provider: LyricsPayload['provider'],
  format: LyricsFormat,
  plainLyrics: string | null,
  syncedLyrics: string | null,
  syncedLines: LyricsLine[]
): LyricsPayload | null {
  const normalizedPlain = normalizeLyricsText(plainLyrics)
  const normalizedSynced = normalizeLyricsText(syncedLyrics)
  const parsedSyncedLines = normalizedSynced && format === 'lrc' ? parseLrcSyncedLines(normalizedSynced) : []
  const sourceLines = parsedSyncedLines.length > 0 ? parsedSyncedLines : syncedLines
  const normalizedLines = sanitizeLyricsLines(sourceLines)

  if (!normalizedPlain && !normalizedSynced && normalizedLines.length === 0) {
    return null
  }

  return {
    source,
    provider,
    format,
    plainLyrics: normalizedPlain ?? toPlainLyricsFromLines(normalizedLines),
    syncedLyrics: normalizedSynced ?? toPlainLyricsFromLines(normalizedLines),
    syncedLines: normalizedLines
  }
}

function parseXlrcLyricsText(lyricsText: string, source: LyricsPayload['source']): LyricsPayload | null {
  const normalizedText = normalizeLyricsText(lyricsText)
  if (!normalizedText) return null

  const parsed = parseXLRC(normalizedText)
  if (parsed.lines.length === 0) return null

  const syncedLines = parsed.lines.map((line): LyricsLine => {
    const text = line.text.trim()
    if (line.isEmpty || !text) {
      return {
        timestampMs: Math.max(0, Math.floor(line.timestamp)),
        text: '',
        kind: 'silence'
      }
    }

    const words = line.words
      .map((word): LyricsWord => {
        const wordFurigana = sanitizeFurigana(word.furigana, word.text)
        return {
          timestampMs: Math.max(0, Math.floor(word.timestamp)),
          text: word.text.trim(),
          ...(wordFurigana.length > 0 ? { furigana: wordFurigana } : {})
        }
      })
      .filter((word) => word.text.length > 0)
    const furigana = sanitizeFurigana(line.furigana, text)
    const translations = sanitizeTranslations(line.translations)
    const voice = line.voice?.trim() || null

    return {
      timestampMs: Math.max(0, Math.floor(line.timestamp)),
      text,
      ...(words.length > 0 ? { words } : {}),
      ...(furigana.length > 0 ? { furigana } : {}),
      ...(translations.length > 0 ? { translations } : {}),
      ...(voice ? { voice } : {})
    }
  })

  return createLyricsPayload(
    source,
    null,
    'xlrc',
    toPlainLyricsFromLines(syncedLines),
    normalizedText,
    syncedLines
  )
}

export function parseLyricsText(
  lyricsText: string,
  source: LyricsPayload['source'],
  format: LyricsFormat = 'lrc'
): LyricsPayload | null {
  const normalizedText = normalizeLyricsText(lyricsText)
  if (!normalizedText) return null

  if (format === 'xlrc') {
    return parseXlrcLyricsText(normalizedText, source)
  }

  if (format === 'plain') {
    return createLyricsPayload(source, null, 'plain', normalizedText, null, [])
  }

  const syncedLines = parseLrcSyncedLines(normalizedText)
  const hasSyncedLyrics = syncedLines.length > 0
  const syncedLyrics = hasSyncedLyrics ? normalizedText : null
  const plainLyrics = hasSyncedLyrics
    ? (toPlainLyricsFromLines(syncedLines) ?? normalizedText)
    : normalizedText

  return createLyricsPayload(source, null, hasSyncedLyrics ? 'lrc' : 'plain', plainLyrics, syncedLyrics, syncedLines)
}
