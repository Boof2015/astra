export interface ArtistNameToken {
  artist: string
  separator: string | null
}

export interface ArtistIdentityTrackLike {
  artist: string
  album?: string | null
  artist_names?: readonly string[] | null
  artist_names_json?: string | null
  album_artist?: string | null
  album_artist_names?: readonly string[] | null
  album_artist_names_json?: string | null
}

export interface ArtistIdentityIndex {
  factualKeys: ReadonlySet<string>
  structuredKeys: ReadonlySet<string>
  rawCreditCounts: ReadonlyMap<string, number>
  /** Ampersand credits anchored by facts or one direct repeated co-credit. */
  corroboratedAmpersandCreditKeys: ReadonlySet<string>
  /** Albums whose raw credits consistently use ampersands as list punctuation. */
  ampersandListAlbumKeys: ReadonlySet<string>
}

const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\u2060\ufeff]/g
const IDENTITY_APOSTROPHE_PATTERN = /[\u2018\u2019\u02bc]/g
const GENERIC_ARTIST_KEY = 'various artists'
const GENERIC_ARTIST_KEYS = new Set([
  GENERIC_ARTIST_KEY,
  'various artist',
  'va',
  'v.a.',
  'v/a',
  'v a'
])
const STRONG_CREDIT_SEPARATOR_PATTERN = /\s*;\s*|\s+(?:feat\.?|ft\.?|featuring|with|[x×])\s+/gi
const ANY_CREDIT_SEPARATOR_PATTERN = /[,;&]|\s+(?:feat\.?|ft\.?|featuring|with|[x×])\s+/i

export function normalizeArtistDisplay(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(ZERO_WIDTH_PATTERN, '').replace(/\s+/g, ' ').trim()
    : ''
}

export function normalizeIdentityKey(value: unknown): string {
  const display = normalizeArtistDisplay(value)
  if (!display) return ''
  return display.replace(IDENTITY_APOSTROPHE_PATTERN, "'").toLocaleLowerCase()
}

export function normalizeArtistKey(value: unknown): string {
  const key = normalizeIdentityKey(value)
  return GENERIC_ARTIST_KEYS.has(key) ? GENERIC_ARTIST_KEY : key
}

export function isGenericArtistName(value: unknown): boolean {
  return normalizeArtistKey(value) === GENERIC_ARTIST_KEY
}

export function canonicalizeArtistDisplay(value: unknown): string {
  const display = normalizeArtistDisplay(value)
  return isGenericArtistName(display) ? 'Various Artists' : display
}

export function normalizeArtistName(value: unknown): string {
  return normalizeArtistDisplay(value)
}

export function normalizeArtistNames(values: readonly unknown[] | null | undefined): string[] {
  if (!values) return []

  const unique = new Map<string, string>()
  for (const value of values) {
    const display = normalizeArtistName(value)
    if (!display) continue
    const key = normalizeArtistKey(display)
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

export function buildArtistCreditTokens(
  rawArtist: string,
  names: readonly unknown[] | null | undefined
): ArtistNameToken[] {
  const normalizedRaw = normalizeArtistDisplay(rawArtist)
  const normalizedNames = normalizeArtistNames(names)
  if (!normalizedRaw || normalizedNames.length === 0) return []
  if (normalizedNames.length === 1) {
    return [{ artist: normalizedNames[0], separator: null }]
  }

  const foldedRaw = normalizedRaw.toLocaleLowerCase()
  const positions: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const name of normalizedNames) {
    const start = foldedRaw.indexOf(name.toLocaleLowerCase(), cursor)
    if (start < 0) return buildArtistNameTokens(normalizedNames)
    positions.push({ start, end: start + name.length })
    cursor = start + name.length
  }

  return normalizedNames.map((artist, index) => {
    const next = positions[index + 1]
    const separator = next
      ? normalizedRaw.slice(positions[index].end, next.start).replace(/\s+/g, ' ')
      : null
    return { artist, separator: separator || (next ? ' & ' : null) }
  })
}

function structuredNamesForTrack(track: ArtistIdentityTrackLike, albumArtist: boolean): string[] {
  const direct = normalizeArtistNames(albumArtist ? track.album_artist_names : track.artist_names)
  if (direct.length > 0) return direct
  return deserializeArtistNames(albumArtist ? track.album_artist_names_json : track.artist_names_json)
}

function addFactualName(target: Set<string>, value: unknown): void {
  const key = normalizeArtistKey(value)
  if (!key) return
  target.add(key)
}

function addRawCredit(counts: Map<string, number>, value: unknown): void {
  const key = normalizeArtistKey(value)
  if (!key) return
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** Builds facts only from source metadata; fallback guesses never become evidence. */
export function buildArtistIdentityIndex(tracks: readonly ArtistIdentityTrackLike[]): ArtistIdentityIndex {
  const factualKeys = new Set<string>()
  const structuredKeys = new Set<string>()
  const rawCreditCounts = new Map<string, number>()
  const uniqueAlbumArtistCredits = new Map<string, string>()

  for (const track of tracks) {
    for (const name of structuredNamesForTrack(track, false)) {
      addFactualName(factualKeys, name)
      addFactualName(structuredKeys, name)
    }
    for (const name of structuredNamesForTrack(track, true)) {
      addFactualName(factualKeys, name)
      addFactualName(structuredKeys, name)
    }

    const artistDisplay = normalizeArtistDisplay(track.artist)
    if (artistDisplay) {
      addRawCredit(rawCreditCounts, artistDisplay)
      if (!ANY_CREDIT_SEPARATOR_PATTERN.test(artistDisplay)) addFactualName(factualKeys, artistDisplay)
    }

    const albumArtistDisplay = normalizeArtistDisplay(track.album_artist)
    if (albumArtistDisplay) {
      const albumArtistKey = normalizeArtistKey(albumArtistDisplay)
      uniqueAlbumArtistCredits.set(albumArtistKey, albumArtistDisplay)
      if (!ANY_CREDIT_SEPARATOR_PATTERN.test(albumArtistDisplay)) {
        addFactualName(factualKeys, albumArtistDisplay)
      }
    }
  }

  // ALBUMARTIST is commonly copied verbatim to every track in a release. It
  // remains a factual observation when delimiter-free, but repetition of the
  // same scalar punctuation credit is not independent evidence. Give an
  // album-owner-only credit one occurrence without amplifying boilerplate.
  for (const [key, display] of uniqueAlbumArtistCredits) {
    if (!rawCreditCounts.has(key)) addRawCredit(rawCreditCounts, display)
  }

  const baseIndex: ArtistIdentityIndex = {
    factualKeys,
    structuredKeys,
    rawCreditCounts,
    corroboratedAmpersandCreditKeys: new Set(),
    ampersandListAlbumKeys: new Set()
  }
  const ampersandCandidatesByKey = new Map<string, string[]>()
  const albumEvidence = new Map<string, {
    localObservationKeys: Set<string>
    ampersandCandidates: string[][]
  }>()

  // Some releases use commas/x/ampersands interchangeably for contributor
  // lists. Keep this evidence release-local: it may resolve an otherwise
  // ambiguous ampersand on that release, but it never becomes a library fact.
  for (const track of tracks) {
    const albumKey = normalizeIdentityKey(track.album)
    const eligibleAlbum = Boolean(albumKey) && albumKey !== 'unknown album'
    let evidence = eligibleAlbum ? albumEvidence.get(albumKey) : undefined
    if (eligibleAlbum && !evidence) {
      evidence = { localObservationKeys: new Set(), ampersandCandidates: [] }
      albumEvidence.set(albumKey, evidence)
    }

    const structured = structuredNamesForTrack(track, false)
    if (structured.length > 0) {
      for (const name of structured) {
        const key = normalizeArtistKey(name)
        if (key) evidence?.localObservationKeys.add(key)
      }
      continue
    }

    const rawArtist = normalizeArtistDisplay(track.artist)
    if (!rawArtist || shouldPreserveDominantCompound(rawArtist, baseIndex)) continue
    const clauses = rawArtist
      .split(STRONG_CREDIT_SEPARATOR_PATTERN)
      .flatMap((part) => part.split(/\s*,\s*/))
      .map(normalizeArtistDisplay)
      .filter(Boolean)

    for (const clause of clauses) {
      const ampersandParts = clause.split(/\s+&\s+/).map(normalizeArtistDisplay).filter(Boolean)
      if (ampersandParts.length > 1) {
        const candidateKey = normalizeArtistKey(clause)
        if (candidateKey) ampersandCandidatesByKey.set(candidateKey, ampersandParts)
        evidence?.ampersandCandidates.push(ampersandParts)
      } else {
        const key = normalizeArtistKey(clause)
        if (key) evidence?.localObservationKeys.add(key)
      }
    }
  }

  // A factual participant strongly suggests an ampersand is credit punctuation.
  // Permit one additional hop when the same observed participant occurs in a
  // second raw ampersand credit. This handles A & B / C & B without turning B
  // into a reusable fact or allowing an unbounded inference chain.
  const directlyAnchoredAmpersandKeys = new Set<string>()
  const directlyAnchoredObservationKeys = new Set<string>()
  for (const [candidateKey, parts] of ampersandCandidatesByKey) {
    if (!parts.some((part) => factualKeys.has(normalizeArtistKey(part)))) continue
    directlyAnchoredAmpersandKeys.add(candidateKey)
    for (const part of parts) directlyAnchoredObservationKeys.add(normalizeArtistKey(part))
  }
  const corroboratedAmpersandCreditKeys = new Set(directlyAnchoredAmpersandKeys)
  for (const [candidateKey, parts] of ampersandCandidatesByKey) {
    if (parts.some((part) => directlyAnchoredObservationKeys.has(normalizeArtistKey(part)))) {
      corroboratedAmpersandCreditKeys.add(candidateKey)
    }
  }

  const ampersandListAlbumKeys = new Set<string>()
  for (const [albumKey, evidence] of albumEvidence) {
    const total = evidence.ampersandCandidates.length
    if (total < 3) continue
    const supported = evidence.ampersandCandidates.filter((parts) => parts.some((part) => {
      const key = normalizeArtistKey(part)
      return factualKeys.has(key) || evidence.localObservationKeys.has(key)
    })).length
    if (supported >= 2 && supported * 2 >= total) {
      ampersandListAlbumKeys.add(albumKey)
    }
  }

  return {
    factualKeys,
    structuredKeys,
    rawCreditCounts,
    corroboratedAmpersandCreditKeys,
    ampersandListAlbumKeys
  }
}

interface ProtectedFactualIdentities {
  protectedValue: string
  replacements: ReadonlyMap<string, string>
}

function protectLongestFactualIdentities(
  value: string,
  index: ArtistIdentityIndex
): ProtectedFactualIdentities {
  const separators = /\s*[,;]\s*|\s+(?:&|feat\.?|ft\.?|featuring|with|[x×])\s+/gi
  const components: Array<{ start: number; end: number }> = []
  let componentCursor = 0
  for (let match = separators.exec(value); match; match = separators.exec(value)) {
    const raw = value.slice(componentCursor, match.index)
    const leading = raw.search(/\S/)
    if (leading >= 0) {
      components.push({ start: componentCursor + leading, end: componentCursor + raw.trimEnd().length })
    }
    componentCursor = separators.lastIndex
  }
  const tail = value.slice(componentCursor)
  const tailLeading = tail.search(/\S/)
  if (tailLeading >= 0) {
    components.push({ start: componentCursor + tailLeading, end: componentCursor + tail.trimEnd().length })
  }

  const candidates: Array<{ start: number; end: number; display: string }> = []
  for (let startIndex = 0; startIndex < components.length; startIndex += 1) {
    for (let endIndex = startIndex; endIndex < components.length; endIndex += 1) {
      const start = components[startIndex].start
      const end = components[endIndex].end
      const display = value.slice(start, end)
      const key = normalizeArtistKey(display)
      if (key !== GENERIC_ARTIST_KEY && index.factualKeys.has(key)) {
        candidates.push({ start, end, display })
      }
    }
  }
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const spans: Array<{ start: number; end: number; display: string }> = []

  for (const candidate of candidates) {
    const overlaps = spans.some((span) => candidate.start < span.end && candidate.end > span.start)
    if (!overlaps) {
      spans.push(candidate)
    }
  }

  if (spans.length === 0) return { protectedValue: value, replacements: new Map() }
  spans.sort((a, b) => a.start - b.start)
  const replacements = new Map<string, string>()
  let protectedValue = ''
  let cursor = 0
  spans.forEach((span, indexValue) => {
    const placeholder = `\uE000${indexValue}\uE001`
    protectedValue += value.slice(cursor, span.start) + placeholder
    replacements.set(placeholder, span.display)
    cursor = span.end
  })
  protectedValue += value.slice(cursor)
  return { protectedValue, replacements }
}

function splitAmpersandWhenFactual(
  value: string,
  index: ArtistIdentityIndex,
  protectedIdentities: ReadonlyMap<string, string> = new Map(),
  splitFromAlbumEvidence: boolean = false
): string[] {
  const parts = value.split(/\s+&\s+/).map(normalizeArtistDisplay).filter(Boolean)
  if (parts.length <= 1) return [value]
  let restoredValue = value
  for (const [placeholder, factualDisplay] of protectedIdentities) {
    restoredValue = restoredValue.replaceAll(placeholder, factualDisplay)
  }
  const corroborated = index.corroboratedAmpersandCreditKeys.has(normalizeArtistKey(restoredValue))
  return splitFromAlbumEvidence || corroborated || parts.every((part) => (
    protectedIdentities.has(part) || index.factualKeys.has(normalizeArtistKey(part))
  )) ? parts : [value]
}

function allPunctuationComponents(value: string): string[] {
  return value
    .split(STRONG_CREDIT_SEPARATOR_PATTERN)
    .flatMap((part) => part.split(/\s*,\s*|\s+&\s+/))
    .map(normalizeArtistDisplay)
    .filter(Boolean)
}

function shouldPreserveDominantCompound(value: string, index: ArtistIdentityIndex): boolean {
  if (!ANY_CREDIT_SEPARATOR_PATTERN.test(value)) return false
  const wholeCount = index.rawCreditCounts.get(normalizeArtistKey(value)) ?? 0
  if (wholeCount < 8) return false

  const components = allPunctuationComponents(value)
  if (components.length <= 1) return false
  if (components.some((part) => index.factualKeys.has(normalizeArtistKey(part)))) return false

  let largestComponentCount = 0
  for (const component of components) {
    largestComponentCount = Math.max(
      largestComponentCount,
      index.rawCreditCounts.get(normalizeArtistKey(component)) ?? 0
    )
  }
  return wholeCount >= Math.max(8, largestComponentCount * 4)
}

function resolveFallbackClause(
  value: string,
  index: ArtistIdentityIndex,
  protectedIdentities: ReadonlyMap<string, string> = new Map(),
  splitFromAlbumEvidence: boolean = false
): string[] {
  const display = normalizeArtistDisplay(value)
  if (!display) return []
  const key = normalizeArtistKey(display)
  if (index.structuredKeys.has(key) || shouldPreserveDominantCompound(display, index)) {
    return [display]
  }

  const commaParts = display.split(/\s*,\s*/).map(normalizeArtistDisplay).filter(Boolean)
  return commaParts.flatMap((part) => {
    if (index.structuredKeys.has(normalizeArtistKey(part))) return [part]
    return splitAmpersandWhenFactual(part, index, protectedIdentities, splitFromAlbumEvidence)
  })
}

export function resolveArtistCredit(
  rawArtist: string,
  index: ArtistIdentityIndex,
  context?: { album?: string | null }
): string[] {
  const display = normalizeArtistDisplay(rawArtist)
  if (!display) return []
  if (index.structuredKeys.has(normalizeArtistKey(display)) || shouldPreserveDominantCompound(display, index)) {
    return [display]
  }

  const protectedIdentities = protectLongestFactualIdentities(display, index)
  const splitFromAlbumEvidence = context?.album
    ? index.ampersandListAlbumKeys.has(normalizeIdentityKey(context.album))
    : false

  const unique = new Map<string, string>()
  for (const strongPart of protectedIdentities.protectedValue.split(STRONG_CREDIT_SEPARATOR_PATTERN)) {
    for (const resolved of resolveFallbackClause(
      strongPart,
      index,
      protectedIdentities.replacements,
      splitFromAlbumEvidence
    )) {
      let restored = resolved
      for (const [placeholder, factualDisplay] of protectedIdentities.replacements) {
        restored = restored.replaceAll(placeholder, factualDisplay)
      }
      const resolvedDisplay = normalizeArtistDisplay(restored)
      const key = normalizeArtistKey(resolvedDisplay)
      if (!key || unique.has(key)) continue
      unique.set(key, resolvedDisplay)
    }
  }
  return Array.from(unique.values())
}

export function resolveTrackArtistNames(
  track: ArtistIdentityTrackLike,
  index: ArtistIdentityIndex,
  albumArtist: boolean = false
): string[] {
  const structured = structuredNamesForTrack(track, albumArtist)
  if (structured.length > 0) return structured
  return resolveArtistCredit(
    albumArtist ? track.album_artist ?? '' : track.artist,
    index,
    albumArtist ? undefined : { album: track.album }
  )
}
