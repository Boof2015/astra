import { parseXLRC, type XLRCFile, type XLRCLine } from '@boof2015/xlrc'
import type {
  LyricsFormat,
  LyricsFurigana,
  LyricsLine,
  LyricsPayload,
  LyricsTranslation,
  LyricsWord
} from '../../types/lyrics'

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
    const text = record.text
    if (!text.trim()) continue
    const furigana = sanitizeFurigana(record.furigana, text)

    words.push({
      timestampMs,
      text,
      ...(furigana.length > 0 ? { furigana } : {})
    })
  }

  return words
}

function hasCompleteWordCoverage(text: string, words: LyricsWord[]): boolean {
  return words.length > 0 && words.map((word) => word.text).join('') === text
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

    const sanitizedWords = sanitizeWords(record.words)
    const words = hasCompleteWordCoverage(text, sanitizedWords) ? sanitizedWords : []
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

function normalizeParsedOffsetMs(file: XLRCFile): number {
  const offset = file.meta.offset
  return typeof offset === 'number' && Number.isFinite(offset) ? Math.trunc(offset) : 0
}

function applyParsedOffsetMs(timestampMs: number, offsetMs: number): number {
  return Math.max(0, Math.floor(timestampMs + offsetMs))
}

function mapParsedLine(
  line: XLRCLine,
  offsetMs: number,
  options: {
    preserveWordTiming: boolean
    preserveXlrcFields: boolean
  }
): LyricsLine {
  const timestampMs = applyParsedOffsetMs(line.timestamp, offsetMs)
  const text = line.text.trim()
  if (line.isEmpty || !text) {
    return {
      timestampMs,
      text: '',
      kind: 'silence'
    }
  }

  if (!options.preserveWordTiming && !options.preserveXlrcFields) {
    return { timestampMs, text }
  }

  const parsedWords = options.preserveWordTiming
    ? line.words
      .map((word): LyricsWord => {
        const wordText = word.text
        const wordFurigana = options.preserveXlrcFields
          ? sanitizeFurigana(word.furigana, wordText)
          : []
        return {
          timestampMs: applyParsedOffsetMs(word.timestamp, offsetMs),
          text: wordText,
          ...(wordFurigana.length > 0 ? { furigana: wordFurigana } : {})
        }
      })
      .filter((word) => word.text.trim().length > 0)
    : []
  const words = hasCompleteWordCoverage(text, parsedWords) ? parsedWords : []
  const furigana = options.preserveXlrcFields ? sanitizeFurigana(line.furigana, text) : []
  const translations = options.preserveXlrcFields ? sanitizeTranslations(line.translations) : []
  const voice = options.preserveXlrcFields ? line.voice?.trim() || null : null

  return {
    timestampMs,
    text,
    ...(words.length > 0 ? { words } : {}),
    ...(furigana.length > 0 ? { furigana } : {}),
    ...(translations.length > 0 ? { translations } : {}),
    ...(voice ? { voice } : {})
  }
}

const LRC_PARSE_OPTIONS = {
  preserveWordTiming: true,
  preserveXlrcFields: false
} as const

const XLRC_PARSE_OPTIONS = {
  preserveWordTiming: true,
  preserveXlrcFields: true
} as const

function parsePackageSyncedLines(
  lyricsText: string,
  options: {
    preserveWordTiming: boolean
    preserveXlrcFields: boolean
  }
): LyricsLine[] {
  const normalizedText = normalizeLyricsText(lyricsText)
  if (!normalizedText) return []

  const parsed = parseXLRC(normalizedText)
  const offsetMs = normalizeParsedOffsetMs(parsed)
  return sanitizeLyricsLines(parsed.lines.map((line) => (
    mapParsedLine(line, offsetMs, options)
  )))
}

export function parseLrcSyncedLines(lyricsText: string): LyricsLine[] {
  return parsePackageSyncedLines(lyricsText, LRC_PARSE_OPTIONS)
}

function parseXlrcSyncedLines(lyricsText: string): LyricsLine[] {
  return parsePackageSyncedLines(lyricsText, XLRC_PARSE_OPTIONS)
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
  const parsedSyncedLines = normalizedSynced && (format === 'lrc' || format === 'xlrc')
    ? parsePackageSyncedLines(
        normalizedSynced,
        format === 'xlrc' ? XLRC_PARSE_OPTIONS : LRC_PARSE_OPTIONS
      )
    : []
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

  const syncedLines = parseXlrcSyncedLines(normalizedText)
  if (syncedLines.length === 0) return null

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
