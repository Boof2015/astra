import { extname } from 'path'

export type PlaylistImportDetectedFormat = 'csv' | 'm3u' | 'm3u8' | 'xspf' | 'wpl' | 'asx'

export interface ParsedPlaylistEntry {
  path?: string
  title?: string
  artist?: string
  album?: string
}

export interface ParsedPlaylistDocument {
  detectedFormat: PlaylistImportDetectedFormat
  entries: ParsedPlaylistEntry[]
  warnings: string[]
}

const CSV_PATH_COLUMNS = new Set([
  'path',
  'file',
  'filepath',
  'location',
  'url',
  'uri',
  'src'
])

const CSV_TITLE_COLUMNS = new Set(['title', 'track', 'tracktitle'])
const CSV_ARTIST_COLUMNS = new Set(['artist', 'creator', 'author'])
const CSV_ALBUM_COLUMNS = new Set(['album'])

export function parsePlaylistDocument(filePath: string, fileText: string): ParsedPlaylistDocument {
  const extension = extname(filePath).toLowerCase()
  const content = stripUtf8Bom(fileText)

  if (extension === '.csv') {
    return parseCsvDocument(content)
  }
  if (extension === '.m3u') {
    return parseM3uDocument(content, 'm3u')
  }
  if (extension === '.m3u8') {
    return parseM3uDocument(content, 'm3u8')
  }
  if (extension === '.xspf') {
    return parseXspfDocument(content, 'xspf')
  }
  if (extension === '.wpl') {
    return parseWplDocument(content)
  }
  if (extension === '.asx') {
    return parseAsxDocument(content)
  }
  if (extension === '.xml') {
    const detected = detectXmlSchema(content)
    if (detected === 'xspf') return parseXspfDocument(content, 'xspf')
    if (detected === 'wpl') return parseWplDocument(content)
    if (detected === 'asx') return parseAsxDocument(content)
    throw new Error('Unsupported XML playlist schema. Supported schemas: XSPF, WPL, ASX.')
  }

  throw new Error(`Unsupported playlist format "${extension || 'unknown'}".`)
}

function stripUtf8Bom(input: string): string {
  if (input.charCodeAt(0) === 0xFEFF) {
    return input.slice(1)
  }
  return input
}

function parseCsvDocument(content: string): ParsedPlaylistDocument {
  const warnings: string[] = []
  const rows = parseCsvRows(content).filter((row) => row.some((cell) => cell.trim().length > 0))
  if (rows.length === 0) {
    return { detectedFormat: 'csv', entries: [], warnings }
  }

  const header = rows[0].map(normalizeCsvHeaderName)
  const hasHeader = header.some((name) => (
    CSV_PATH_COLUMNS.has(name)
    || CSV_TITLE_COLUMNS.has(name)
    || CSV_ARTIST_COLUMNS.has(name)
    || CSV_ALBUM_COLUMNS.has(name)
  ))

  const rowStart = hasHeader ? 1 : 0
  const pathIndex = findFirstColumnIndex(header, CSV_PATH_COLUMNS)
  const titleIndex = findFirstColumnIndex(header, CSV_TITLE_COLUMNS)
  const artistIndex = findFirstColumnIndex(header, CSV_ARTIST_COLUMNS)
  const albumIndex = findFirstColumnIndex(header, CSV_ALBUM_COLUMNS)

  if (hasHeader && pathIndex === -1) {
    warnings.push('CSV has no recognized path column; metadata-only fallback may be used.')
  }
  if (!hasHeader) {
    warnings.push('CSV has no recognized header row; first column is treated as the path field.')
  }

  const entries: ParsedPlaylistEntry[] = []
  for (let i = rowStart; i < rows.length; i++) {
    const row = rows[i]
    const rawPath = pathIndex >= 0 ? row[pathIndex] ?? '' : row[0] ?? ''
    const rawTitle = titleIndex >= 0 ? row[titleIndex] ?? '' : ''
    const rawArtist = artistIndex >= 0 ? row[artistIndex] ?? '' : ''
    const rawAlbum = albumIndex >= 0 ? row[albumIndex] ?? '' : ''

    const path = toOptionalValue(rawPath)
    const title = toOptionalValue(rawTitle)
    const artist = toOptionalValue(rawArtist)
    const album = toOptionalValue(rawAlbum)
    if (!path && !title && !artist && !album) continue

    entries.push({ path, title, artist, album })
  }

  return { detectedFormat: 'csv', entries, warnings }
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\r') {
      if (content[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }

  row.push(field)
  rows.push(row)
  return rows
}

function normalizeCsvHeaderName(value: string): string {
  return value.replace(/\s+/g, '').trim().toLocaleLowerCase()
}

function findFirstColumnIndex(columns: string[], candidates: Set<string>): number {
  for (let i = 0; i < columns.length; i++) {
    if (candidates.has(columns[i])) {
      return i
    }
  }
  return -1
}

function parseM3uDocument(content: string, detectedFormat: 'm3u' | 'm3u8'): ParsedPlaylistDocument {
  const entries: ParsedPlaylistEntry[] = []
  const warnings: string[] = []
  const lines = content.split(/\r?\n/)
  let pendingInfo: { title?: string; artist?: string } | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^#EXTINF:/i.test(line)) {
      pendingInfo = parseExtInfLine(line)
      continue
    }

    if (line.startsWith('#')) {
      continue
    }

    const path = toOptionalValue(line)
    if (!path) continue

    entries.push({
      path,
      title: pendingInfo?.title,
      artist: pendingInfo?.artist
    })
    pendingInfo = null
  }

  return { detectedFormat, entries, warnings }
}

function parseExtInfLine(line: string): { title?: string; artist?: string } | null {
  const commaIndex = line.indexOf(',')
  if (commaIndex < 0) return null

  const display = toOptionalValue(line.slice(commaIndex + 1))
  if (!display) return null

  const dashIndex = display.indexOf(' - ')
  if (dashIndex <= 0 || dashIndex >= display.length - 3) {
    return { title: display }
  }

  const artist = toOptionalValue(display.slice(0, dashIndex))
  const title = toOptionalValue(display.slice(dashIndex + 3))
  return { title, artist }
}

function parseXspfDocument(content: string, detectedFormat: 'xspf'): ParsedPlaylistDocument {
  const entries: ParsedPlaylistEntry[] = []
  const warnings: string[] = []
  const trackBlocks = matchXmlElementBlocks(content, 'track')

  for (const block of trackBlocks) {
    const path = toOptionalValue(extractXmlElementText(block, 'location'))
    if (!path) continue

    entries.push({
      path,
      title: toOptionalValue(extractXmlElementText(block, 'title')),
      artist: toOptionalValue(extractXmlElementText(block, 'creator')),
      album: toOptionalValue(extractXmlElementText(block, 'album'))
    })
  }

  if (trackBlocks.length === 0) {
    warnings.push('No <track> entries were found in XSPF document.')
  }

  return { detectedFormat, entries, warnings }
}

function parseWplDocument(content: string): ParsedPlaylistDocument {
  const entries: ParsedPlaylistEntry[] = []
  const warnings: string[] = []
  const mediaTagRegex = /<\s*(?:[\w.-]+:)?media\b([^>]*)>/gi
  let match: RegExpExecArray | null

  while ((match = mediaTagRegex.exec(content)) !== null) {
    const source = extractXmlAttribute(match[1] ?? '', 'src')
    if (!source) continue
    entries.push({ path: source })
  }

  if (entries.length === 0) {
    warnings.push('No media entries were found in WPL document.')
  }

  return { detectedFormat: 'wpl', entries, warnings }
}

function parseAsxDocument(content: string): ParsedPlaylistDocument {
  const entries: ParsedPlaylistEntry[] = []
  const warnings: string[] = []
  const entryBlocks = matchXmlElementBlocks(content, 'entry')

  if (entryBlocks.length > 0) {
    for (const entryBlock of entryBlocks) {
      const path = extractFirstRefHref(entryBlock)
      if (!path) continue
      entries.push({
        path,
        title: toOptionalValue(extractXmlElementText(entryBlock, 'title')),
        artist: toOptionalValue(extractXmlElementText(entryBlock, 'author'))
      })
    }
  } else {
    const refTagRegex = /<\s*(?:[\w.-]+:)?ref\b([^>]*)>/gi
    let refMatch: RegExpExecArray | null
    while ((refMatch = refTagRegex.exec(content)) !== null) {
      const path = extractXmlAttribute(refMatch[1] ?? '', 'href')
      if (!path) continue
      entries.push({ path })
    }
  }

  if (entries.length === 0) {
    warnings.push('No <ref href="..."> entries were found in ASX document.')
  }

  return { detectedFormat: 'asx', entries, warnings }
}

function detectXmlSchema(content: string): PlaylistImportDetectedFormat | null {
  const rootMatch = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<\s*([A-Za-z_][\w:.-]*)\b[^>]*>/i.exec(content)
  const rootRaw = rootMatch?.[1] ?? ''
  const rootName = rootRaw.includes(':')
    ? rootRaw.slice(rootRaw.lastIndexOf(':') + 1).toLocaleLowerCase()
    : rootRaw.toLocaleLowerCase()

  if (rootName === 'playlist') return 'xspf'
  if (rootName === 'smil') return 'wpl'
  if (rootName === 'asx') return 'asx'

  if (/<\s*(?:[\w.-]+:)?playlist\b/i.test(content) && /xspf/i.test(content)) return 'xspf'
  if (/<\s*(?:[\w.-]+:)?smil\b/i.test(content) && /<\s*(?:[\w.-]+:)?media\b/i.test(content)) return 'wpl'
  if (/<\s*(?:[\w.-]+:)?asx\b/i.test(content)) return 'asx'

  return null
}

function matchXmlElementBlocks(content: string, localName: string): string[] {
  const pattern = new RegExp(
    `<\\s*(?:[\\w.-]+:)?${localName}\\b[^>]*>[\\s\\S]*?<\\/\\s*(?:[\\w.-]+:)?${localName}\\s*>`,
    'gi'
  )
  return content.match(pattern) ?? []
}

function extractXmlElementText(content: string, localName: string): string | null {
  const pattern = new RegExp(
    `<\\s*(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/\\s*(?:[\\w.-]+:)?${localName}\\s*>`,
    'i'
  )
  const match = pattern.exec(content)
  if (!match) return null
  return decodeXmlText(match[1] ?? '')
}

function extractXmlAttribute(attributes: string, attributeName: string): string | null {
  const attributePattern = new RegExp(`\\b${attributeName}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i')
  const match = attributePattern.exec(attributes)
  if (!match) return null
  return toOptionalValue(decodeXmlText(match[2] ?? '')) ?? null
}

function extractFirstRefHref(content: string): string | null {
  const refPattern = /<\s*(?:[\w.-]+:)?ref\b([^>]*)>/i
  const match = refPattern.exec(content)
  if (!match) return null
  return extractXmlAttribute(match[1] ?? '', 'href')
}

function decodeXmlText(input: string): string {
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(input.trim())
  const source = cdataMatch ? cdataMatch[1] : input
  return source
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number.parseInt(code, 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const parsed = Number.parseInt(code, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
}

function toOptionalValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed
}
