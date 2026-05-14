const MUSICBRAINZ_RELEASE_SEARCH_URL = 'https://musicbrainz.org/ws/2/release'
const COVER_ART_ARCHIVE_RELEASE_URL = 'https://coverartarchive.org/release'
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
const THE_AUDIO_DB_SEARCH_ALBUM_URL = 'https://www.theaudiodb.com/api/v1/json/2/searchalbum.php'
const REQUEST_TIMEOUT_MS = 8000
const MUSICBRAINZ_MIN_INTERVAL_MS = 1000
const MUSICBRAINZ_USER_AGENT = 'Astra-Discord-CoverArt/0.2.0 (https://github.com/Boof2015/astra)'
const RELEASE_SEARCH_LIMIT = 5
const MAX_RELEASE_CANDIDATES_TO_PROBE = 5
const MAX_ARTIST_CANDIDATES = 4
const MAX_ALBUM_CANDIDATES = 3
const ITUNES_SEARCH_LIMIT = 8
const ITUNES_TRACK_SEARCH_LIMIT = 12
const LOOKUP_LOG_INTERVAL_MS = 5000

interface MusicBrainzArtistCredit {
  name?: string
  artist?: {
    name?: string
  }
}

interface MusicBrainzRelease {
  id?: string
  title?: string
  score?: number | string
  'artist-credit'?: MusicBrainzArtistCredit[]
}

interface MusicBrainzReleaseSearchResponse {
  releases?: MusicBrainzRelease[]
}

interface CoverArtArchiveImage {
  front?: boolean
  image?: string
  thumbnails?: Record<string, string | undefined>
}

interface CoverArtArchiveReleaseResponse {
  images?: CoverArtArchiveImage[]
}

interface ItunesAlbumResult {
  collectionName?: string
  artistName?: string
  artworkUrl100?: string
  artworkUrl60?: string
  artworkUrl30?: string
}

interface ItunesSearchResponse {
  results?: ItunesAlbumResult[]
}

interface ItunesTrackResult {
  trackName?: string
  collectionName?: string
  artistName?: string
  artworkUrl100?: string
  artworkUrl60?: string
  artworkUrl30?: string
}

interface ItunesTrackSearchResponse {
  results?: ItunesTrackResult[]
}

interface TheAudioDbAlbum {
  strAlbum?: string
  strArtist?: string
  strAlbumThumb?: string
  strAlbumThumbHQ?: string
}

interface TheAudioDbLookupResponse {
  album?: TheAudioDbAlbum[] | null
}

interface DiscordCoverArtLookupHit {
  status: 'hit'
  url: string
}

interface DiscordCoverArtLookupNotFound {
  status: 'not_found'
}

interface DiscordCoverArtLookupTransientError {
  status: 'transient_error'
  code?: string
}

export type DiscordCoverArtLookupResult =
  | DiscordCoverArtLookupHit
  | DiscordCoverArtLookupNotFound
  | DiscordCoverArtLookupTransientError

export interface DiscordCoverArtLookupQuery {
  album: string
  artist?: string
  albumArtist?: string
  title?: string
}

type FetchJsonResult<T> =
  | {
      kind: 'ok'
      payload: T
    }
  | {
      kind: 'http_error'
      status: number
    }
  | {
      kind: 'timeout'
    }
  | {
      kind: 'network_error'
    }

let nextMusicBrainzRequestAt = 0
let musicBrainzThrottleQueue: Promise<void> = Promise.resolve()
const lookupLogTimestamps = new Map<string, number>()
const isDev = process.env.NODE_ENV === 'development'

interface CandidateScore {
  total: number
  album: number
  title: number
  artist: number
  albumExact: boolean
  albumSuffixStripped: boolean
  artistMatched: boolean
  titleMatched: boolean
}

interface CoverUrlCandidate {
  album: string | null
  title?: string | null
  artist: string | null
  url: string | null
}

interface ProviderResolutionResult {
  result: DiscordCoverArtLookupResult
  candidateCount: number
  hitCandidate?: string
  hitPhase?: string
}

interface ReleaseIdCandidate {
  id: string
  albumCandidate: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeMatchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Patterns operate on normalizeMatchKey output (lowercase, no punctuation, spaces only).
// Parentheses/brackets/dashes are already stripped, so "(Deluxe Edition)" becomes "deluxe edition".
// Order matters: longer/more specific patterns first to avoid partial stripping.
const EDITION_SUFFIX_PATTERNS: RegExp[] = [
  // Release type suffixes (iTunes: "- Single", "- EP")
  /\s+single$/,
  /\s+ep$/,
  /\s+lp$/,
  // Deluxe variants
  /\s+super deluxe edition$/,
  /\s+super deluxe$/,
  /\s+deluxe edition$/,
  /\s+deluxe version$/,
  /\s+deluxe$/,
  // Expanded/extended variants
  /\s+expanded edition$/,
  /\s+expanded version$/,
  /\s+extended version$/,
  /\s+extended mix$/,
  // Bonus/special variants
  /\s+bonus digital booklet version$/,
  /\s+bonus video version$/,
  /\s+bonus track version$/,
  /\s+bonus track edition$/,
  /\s+bonus tracks$/,
  /\s+bonus track$/,
  // Anniversary/collector/special/platinum
  /\s+anniversary edition$/,
  /\s+collector s edition$/,
  /\s+platinum edition$/,
  /\s+special edition$/,
  // Remastered variants
  /\s+remastered \d{4}$/,
  /\s+remastered$/,
  /\s+remaster$/,
  // Live/remix/soundtrack
  /\s+the original soundtrack$/,
  /\s+original soundtrack$/,
  /\s+live$/,
  /\s+remix$/,
  // Content markers
  /\s+explicit$/,
  /\s+clean$/,
  // MusicBrainz-specific ETI
  /\s+album version$/,
  /\s+new song$/
]

function stripEditionSuffixes(normalized: string): string {
  let current = normalized
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of EDITION_SUFFIX_PATTERNS) {
      const stripped = current.replace(pattern, '')
      if (stripped !== current) {
        current = stripped.trim()
        changed = true
        break
      }
    }
  }
  return current
}

function stripTrailingFeaturedArtistClause(value: string): string | null {
  const normalized = normalizeText(value)
  if (!normalized) return null

  const stripped = normalized
    .replace(/\s*[\(\[\{]?\s*(?:feat\.?|ft\.?|featuring|with)\s+.+$/i, '')
    .replace(/\s*[-\u2013]\s*(?:feat\.?|ft\.?|featuring|with)\s+.+$/i, '')
    .trim()

  return normalizeText(stripped)
}

function appendLookupCandidate(value: string | null, target: string[], seen: Set<string>): void {
  if (target.length >= MAX_ALBUM_CANDIDATES) return

  const normalized = normalizeText(value)
  if (!normalized) return

  const key = normalizeMatchKey(normalized)
  if (!key || seen.has(key)) return

  seen.add(key)
  target.push(normalized)
}

export function buildCoverArtAlbumCandidates(album: string, title?: string | null): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()

  appendLookupCandidate(album, candidates, seen)
  appendLookupCandidate(stripTrailingFeaturedArtistClause(album), candidates, seen)

  const normalizedTitle = normalizeText(title)
  if (
    normalizedTitle
    && normalizeMatchKey(normalizedTitle) !== normalizeMatchKey(album)
  ) {
    appendLookupCandidate(normalizedTitle, candidates, seen)
    appendLookupCandidate(stripTrailingFeaturedArtistClause(normalizedTitle), candidates, seen)
  }

  return candidates
}

function buildCoverArtTitleCandidates(title: string | null): string[] {
  if (!title) return []

  const candidates: string[] = []
  const seen = new Set<string>()

  appendLookupCandidate(title, candidates, seen)
  appendLookupCandidate(stripTrailingFeaturedArtistClause(title), candidates, seen)

  return candidates
}

function toLogKey(album: string, artist: string | null): string {
  return `${normalizeMatchKey(album)}::${normalizeMatchKey(artist ?? '')}`
}

function logLookup(event: string, key: string, details: Record<string, unknown>): void {
  if (!isDev) return
  const entryKey = `${event}:${key}`
  const now = Date.now()
  const previous = lookupLogTimestamps.get(entryKey) ?? 0
  if (now - previous < LOOKUP_LOG_INTERVAL_MS) return
  lookupLogTimestamps.set(entryKey, now)
  console.debug(`[discord-cover-art] ${event}`, details)
}

function splitArtistCandidates(value: string): string[] {
  const normalized = normalizeText(value)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const candidates: string[] = []
  const seen = new Set<string>()
  for (const segment of unified.split(',')) {
    const candidate = normalizeText(segment)
    if (!candidate) continue
    const key = normalizeMatchKey(candidate)
    if (!key || seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }

  return candidates
}

function isUnknownMetadata(value: string, type: 'artist' | 'album'): boolean {
  const normalized = normalizeMatchKey(value)
  if (!normalized) return true
  if (type === 'artist') {
    return normalized === 'unknown artist'
  }
  return normalized === 'unknown album'
}

function isGenericArtistMetadata(value: string): boolean {
  const normalized = normalizeMatchKey(value)
  return normalized === 'various artists'
    || normalized === 'various artist'
    || normalized === 'va'
    || normalized === 'v a'
}

function isLowQualityArtistMetadata(value: string): boolean {
  return isUnknownMetadata(value, 'artist') || isGenericArtistMetadata(value)
}

function appendArtistCandidatesFromValue(
  value: string | null,
  target: string[],
  seen: Set<string>
): void {
  if (!value) return
  const split = splitArtistCandidates(value)
  const candidates = split.length > 0 ? split : [value]

  for (const candidate of candidates) {
    if (isLowQualityArtistMetadata(candidate)) continue
    const key = normalizeMatchKey(candidate)
    if (!key || seen.has(key)) continue
    seen.add(key)
    target.push(candidate)
    if (target.length >= MAX_ARTIST_CANDIDATES) return
  }
}

function resolveLookupArtistCandidates(trackArtist: string | null, albumArtist: string | null): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()

  appendArtistCandidatesFromValue(trackArtist, candidates, seen)
  if (candidates.length >= MAX_ARTIST_CANDIDATES) return candidates

  if (albumArtist && !isGenericArtistMetadata(albumArtist)) {
    appendArtistCandidatesFromValue(albumArtist, candidates, seen)
  }

  return candidates
}

function pickLookupLogArtist(
  trackArtist: string | null,
  albumArtist: string | null,
  artistCandidates: string[]
): string | null {
  if (artistCandidates.length > 0) return artistCandidates[0] ?? null
  if (trackArtist && !isUnknownMetadata(trackArtist, 'artist')) return trackArtist
  if (albumArtist && !isUnknownMetadata(albumArtist, 'artist')) return albumArtist
  return null
}

function escapeMusicBrainzQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function parseSearchScore(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function scoreAlbumField(candidateAlbum: string | null, albums: readonly string[]): number {
  const normalizedCandidate = normalizeMatchKey(candidateAlbum ?? '')
  if (!normalizedCandidate) return 0

  let bestScore = 0
  for (const album of albums) {
    const targetAlbum = normalizeMatchKey(album)
    if (!targetAlbum) continue
    if (normalizedCandidate === targetAlbum) {
      bestScore = Math.max(bestScore, 40)
      continue
    }
    if (normalizedCandidate.startsWith(targetAlbum) || targetAlbum.startsWith(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 18)
      continue
    }
    if (normalizedCandidate.includes(targetAlbum) || targetAlbum.includes(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 10)
    }
  }

  return bestScore
}

function isExactAlbumFieldMatch(candidateAlbum: string | null, albums: readonly string[]): boolean {
  const normalizedCandidate = normalizeMatchKey(candidateAlbum ?? '')
  if (!normalizedCandidate) return false

  return albums.some((album) => {
    const targetAlbum = normalizeMatchKey(album)
    return Boolean(targetAlbum) && normalizedCandidate === targetAlbum
  })
}

function isStrippedAlbumFieldMatch(candidateAlbum: string | null, albums: readonly string[]): boolean {
  const normalizedCandidate = normalizeMatchKey(candidateAlbum ?? '')
  if (!normalizedCandidate) return false

  for (const album of albums) {
    const targetAlbum = normalizeMatchKey(album)
    if (!targetAlbum) continue
    if (normalizedCandidate === targetAlbum) continue
    if (stripEditionSuffixes(normalizedCandidate) === stripEditionSuffixes(targetAlbum)) return true
  }

  return false
}

function scoreTitleField(candidateTitle: string | null | undefined, titles: readonly string[]): number {
  if (titles.length === 0) return 0
  const normalizedCandidate = normalizeMatchKey(candidateTitle ?? '')
  if (!normalizedCandidate) return 0

  let bestScore = 0
  for (const title of titles) {
    const targetTitle = normalizeMatchKey(title)
    if (!targetTitle) continue
    if (normalizedCandidate === targetTitle) {
      bestScore = Math.max(bestScore, 40)
      continue
    }
    if (stripEditionSuffixes(normalizedCandidate) === stripEditionSuffixes(targetTitle)) {
      bestScore = Math.max(bestScore, 25)
    }
  }

  return bestScore
}

function isShortTokenOrderArtistMatch(left: string, right: string): boolean {
  if (left === right) return true

  const leftParts = left.split(' ').filter(Boolean)
  const rightParts = right.split(' ').filter(Boolean)
  if (leftParts.length < 2 || rightParts.length < 2) return false
  if (leftParts.length !== rightParts.length) return false
  if (leftParts.length > 4) return false

  const sortedLeft = [...leftParts].sort().join(' ')
  const sortedRight = [...rightParts].sort().join(' ')
  return sortedLeft === sortedRight
}

function scoreArtistField(candidateArtist: string | null, artists: readonly string[]): number {
  if (artists.length === 0) return 0
  const normalizedCandidate = normalizeMatchKey(candidateArtist ?? '')
  if (!normalizedCandidate) return 0

  let bestScore = 0
  for (const artist of artists) {
    const targetArtist = normalizeMatchKey(artist)
    if (!targetArtist) continue
    if (normalizedCandidate === targetArtist) {
      bestScore = Math.max(bestScore, 25)
      continue
    }
    if (isShortTokenOrderArtistMatch(normalizedCandidate, targetArtist)) {
      bestScore = Math.max(bestScore, 22)
      continue
    }
    if (normalizedCandidate.includes(targetArtist) || targetArtist.includes(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 12)
    }
  }

  return bestScore
}

function scoreAlbumArtistMatch(
  candidateAlbum: string | null,
  candidateArtist: string | null,
  albums: readonly string[],
  artists: readonly string[]
): CandidateScore {
  const albumScore = scoreAlbumField(candidateAlbum, albums)
  const artistScore = scoreArtistField(candidateArtist, artists)
  const albumExact = isExactAlbumFieldMatch(candidateAlbum, albums)
  const albumSuffixStripped = !albumExact && isStrippedAlbumFieldMatch(candidateAlbum, albums)
  const artistMatched = artists.length === 0 ? false : artistScore > 0

  return {
    total: albumScore + artistScore,
    album: albumScore,
    title: 0,
    artist: artistScore,
    albumExact,
    albumSuffixStripped,
    artistMatched,
    titleMatched: false
  }
}

function pickBetterCandidate(
  current: { url: string; score: CandidateScore } | null,
  candidate: { url: string; score: CandidateScore }
): { url: string; score: CandidateScore } {
  if (!current || candidate.score.total > current.score.total) return candidate
  if (
    candidate.score.total === current.score.total
    && candidate.score.artist === current.score.artist
    && candidate.score.album > current.score.album
  ) return candidate
  if (candidate.score.total === current.score.total && candidate.score.artist > current.score.artist) return candidate
  if (candidate.score.total === current.score.total && candidate.score.title > current.score.title) return candidate
  return current
}

function chooseBestCoverCandidate(
  candidates: CoverUrlCandidate[],
  albums: readonly string[],
  artists: string[],
  options: {
    requireArtistMatch: boolean
    allowSuffixStrippedMatch: boolean
  }
): string | null {
  // Pass 1 (strict): require exact album match + artist match (when required)
  let best: { url: string; score: CandidateScore } | null = null

  for (const candidate of candidates) {
    if (!candidate.url) continue
    const score = scoreAlbumArtistMatch(candidate.album, candidate.artist, albums, artists)
    if (!score.albumExact) continue
    if (options.requireArtistMatch && !score.artistMatched) continue
    best = pickBetterCandidate(best, { url: candidate.url, score })
  }

  if (best) return best.url

  // Pass 2 (relaxed album): accept suffix-stripped album matches, but still
  // enforce the artist gate. This only helps with edition mismatches like
  // "Album (Deluxe)" vs "Album (Deluxe Edition)", not artist mismatches.
  if (!options.allowSuffixStrippedMatch) return null

  for (const candidate of candidates) {
    if (!candidate.url) continue
    const score = scoreAlbumArtistMatch(candidate.album, candidate.artist, albums, artists)
    if (!score.albumSuffixStripped) continue
    if (options.requireArtistMatch && !score.artistMatched) continue
    best = pickBetterCandidate(best, { url: candidate.url, score })
  }

  return best?.url ?? null
}

function chooseBestTrackCoverCandidate(
  candidates: CoverUrlCandidate[],
  titles: readonly string[],
  artists: string[],
  options: {
    requireArtistMatch: boolean
  }
): string | null {
  let best: { url: string; score: CandidateScore } | null = null

  for (const candidate of candidates) {
    if (!candidate.url) continue
    const titleScore = scoreTitleField(candidate.title, titles)
    if (titleScore <= 0) continue

    const artistScore = scoreArtistField(candidate.artist, artists)
    const artistMatched = artists.length === 0 ? false : artistScore > 0
    if (options.requireArtistMatch && !artistMatched) continue

    best = pickBetterCandidate(best, {
      url: candidate.url,
      score: {
        total: titleScore + artistScore,
        album: 0,
        title: titleScore,
        artist: artistScore,
        albumExact: false,
        albumSuffixStripped: false,
        artistMatched,
        titleMatched: true
      }
    })
  }

  return best?.url ?? null
}

function releaseArtistLine(release: MusicBrainzRelease): string {
  if (!Array.isArray(release['artist-credit'])) return ''
  return release['artist-credit']
    .map((credit) => normalizeText(credit.name ?? credit.artist?.name))
    .filter((value): value is string => Boolean(value))
    .join(', ')
}

function scoreReleaseCandidate(release: MusicBrainzRelease, albums: readonly string[], artists: string[]): number {
  let score = parseSearchScore(release.score)

  const releaseTitle = normalizeMatchKey(release.title ?? '')

  if (releaseTitle) {
    for (const album of albums) {
      const targetAlbum = normalizeMatchKey(album)
      if (!targetAlbum) continue
      if (releaseTitle === targetAlbum) {
        score += 40
        break
      } else if (releaseTitle.startsWith(targetAlbum)) {
        score += 18
        break
      } else if (releaseTitle.includes(targetAlbum)) {
        score += 10
        break
      }
    }
  }

  score += scoreArtistField(releaseArtistLine(release), artists)

  return score
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<FetchJsonResult<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    })

    if (!response.ok) {
      return {
        kind: 'http_error',
        status: response.status
      }
    }

    const payload: unknown = await response.json()
    return {
      kind: 'ok',
      payload: payload as T
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'timeout' }
    }
    return { kind: 'network_error' }
  } finally {
    clearTimeout(timeout)
  }
}

async function withMusicBrainzThrottle<T>(operation: () => Promise<T>): Promise<T> {
  const run = musicBrainzThrottleQueue.then(async () => {
    const now = Date.now()
    const waitMs = Math.max(0, nextMusicBrainzRequestAt - now)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    nextMusicBrainzRequestAt = Date.now() + MUSICBRAINZ_MIN_INTERVAL_MS
    return operation()
  })

  musicBrainzThrottleQueue = run.then(
    () => undefined,
    () => undefined
  )

  return run
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function resolveTransientCode(prefix: string, result: FetchJsonResult<unknown>): string {
  if (result.kind === 'timeout') return `${prefix}_timeout`
  if (result.kind === 'network_error') return `${prefix}_network_error`
  if (result.kind === 'http_error') return `${prefix}_http_${result.status}`
  return `${prefix}_unknown_error`
}

type ReleaseCandidateResolutionResult =
  | {
      status: 'ok'
      releaseIds: string[]
    }
  | {
      status: 'not_found'
    }
  | {
      status: 'transient_error'
      code: string
    }

async function resolveReleaseCandidates(
  album: string,
  artist: string | null,
  albumCandidates: readonly string[] = [album]
): Promise<ReleaseCandidateResolutionResult> {
  const queryParts = [
    `release:"${escapeMusicBrainzQueryValue(album)}"`
  ]
  if (artist) {
    queryParts.push(`artist:"${escapeMusicBrainzQueryValue(artist)}"`)
  }
  const params = new URLSearchParams({
    query: queryParts.join(' AND '),
    fmt: 'json',
    limit: String(RELEASE_SEARCH_LIMIT)
  })

  const response = await withMusicBrainzThrottle(() => fetchJson<MusicBrainzReleaseSearchResponse>(
    `${MUSICBRAINZ_RELEASE_SEARCH_URL}?${params.toString()}`,
    {
      Accept: 'application/json',
      'User-Agent': MUSICBRAINZ_USER_AGENT
    }
  ))

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      code: resolveTransientCode('musicbrainz', response)
    }
  }

  const releases = Array.isArray(response.payload.releases) ? response.payload.releases : null
  if (!releases) {
    return {
      status: 'transient_error',
      code: 'musicbrainz_invalid_payload'
    }
  }
  if (releases.length === 0) {
    return { status: 'not_found' }
  }

  const targetArtists = artist ? [artist] : []
  const releasesWithIds = releases
    .filter((release) => Boolean(normalizeText(release.id)))
  const strictMatches = releasesWithIds
    .filter((release) => {
      if (!isExactAlbumFieldMatch(normalizeText(release.title), albumCandidates)) return false
      if (targetArtists.length === 0) return true
      return scoreArtistField(releaseArtistLine(release), targetArtists) > 0
    })

  const releasesForOrdering = strictMatches.length > 0 ? strictMatches : releasesWithIds
  const seenReleaseIds = new Set<string>()
  const orderedIds = releasesForOrdering
    .sort((left, right) => {
      return scoreReleaseCandidate(right, albumCandidates, targetArtists) -
        scoreReleaseCandidate(left, albumCandidates, targetArtists)
    })
    .map((release) => normalizeText(release.id))
    .filter((value): value is string => Boolean(value))
    .filter((value) => {
      if (seenReleaseIds.has(value)) return false
      seenReleaseIds.add(value)
      return true
    })

  if (orderedIds.length === 0) {
    return { status: 'not_found' }
  }

  return {
    status: 'ok',
    releaseIds: orderedIds
  }
}

function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null

  try {
    const url = new URL(normalized)
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
    }
    if (url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function selectCoverArtUrl(payload: CoverArtArchiveReleaseResponse): string | null {
  const images = Array.isArray(payload.images) ? payload.images : null
  if (!images || images.length === 0) return null

  const prioritized = [...images].sort((left, right) => {
    const rightFront = right.front ? 1 : 0
    const leftFront = left.front ? 1 : 0
    return rightFront - leftFront
  })

  for (const image of prioritized) {
    const thumbnail500 = toHttpsUrl(image.thumbnails?.['500'])
    if (thumbnail500) return thumbnail500

    const thumbnailLarge = toHttpsUrl(image.thumbnails?.large)
    if (thumbnailLarge) return thumbnailLarge

    const thumbnailSmall = toHttpsUrl(image.thumbnails?.small)
    if (thumbnailSmall) return thumbnailSmall

    const fullImage = toHttpsUrl(image.image)
    if (fullImage) return fullImage
  }

  return null
}

async function resolveCoverArtForRelease(releaseId: string): Promise<DiscordCoverArtLookupResult> {
  const response = await fetchJson<CoverArtArchiveReleaseResponse>(
    `${COVER_ART_ARCHIVE_RELEASE_URL}/${encodeURIComponent(releaseId)}`,
    {
      Accept: 'application/json',
      'User-Agent': MUSICBRAINZ_USER_AGENT
    }
  )

  if (response.kind === 'http_error') {
    if (response.status === 404) {
      return { status: 'not_found' }
    }
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        code: `cover_art_archive_http_${response.status}`
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      code: resolveTransientCode('cover_art_archive', response)
    }
  }

  if (!response.payload || typeof response.payload !== 'object') {
    return {
      status: 'transient_error',
      code: 'cover_art_archive_invalid_payload'
    }
  }

  const coverArtUrl = selectCoverArtUrl(response.payload)
  if (!coverArtUrl) {
    return { status: 'not_found' }
  }

  return {
    status: 'hit',
    url: coverArtUrl
  }
}

function normalizeUrlOrNull(value: unknown): string | null {
  const normalized = normalizeText(value)
  if (!normalized) return null
  return toHttpsUrl(normalized)
}

function upscaleItunesArtwork(url: string): string {
  return url.replace(/\/\d+x\d+(bb(?:-\d+)?)\./i, '/600x600$1.')
}

function selectItunesCoverUrl(entry: ItunesAlbumResult | ItunesTrackResult): string | null {
  const artworkCandidates = [
    normalizeText(entry.artworkUrl100),
    normalizeText(entry.artworkUrl60),
    normalizeText(entry.artworkUrl30)
  ]

  for (const artworkCandidate of artworkCandidates) {
    if (!artworkCandidate) continue
    const normalized = toHttpsUrl(upscaleItunesArtwork(artworkCandidate))
    if (normalized) return normalized
  }

  return null
}

async function resolveCoverArtFromItunesSearch(
  album: string,
  artist: string | null,
  albumCandidates: readonly string[] = [album]
): Promise<DiscordCoverArtLookupResult> {
  const term = artist ? `${album} ${artist}` : album
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'album',
    limit: String(ITUNES_SEARCH_LIMIT)
  })

  const response = await fetchJson<ItunesSearchResponse>(
    `${ITUNES_SEARCH_URL}?${params.toString()}`,
    {
      Accept: 'application/json',
      'User-Agent': MUSICBRAINZ_USER_AGENT
    }
  )

  if (response.kind === 'http_error') {
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        code: `itunes_http_${response.status}`
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      code: resolveTransientCode('itunes', response)
    }
  }

  const results = Array.isArray(response.payload.results) ? response.payload.results : null
  if (!results) {
    return {
      status: 'transient_error',
      code: 'itunes_invalid_payload'
    }
  }
  if (results.length === 0) return { status: 'not_found' }

  const targetArtists = artist ? [artist] : []
  const coverArtUrl = chooseBestCoverCandidate(
    results.map((entry) => ({
      album: normalizeText(entry.collectionName),
      artist: normalizeText(entry.artistName),
      url: selectItunesCoverUrl(entry)
    })),
    albumCandidates,
    targetArtists,
    {
      requireArtistMatch: targetArtists.length > 0,
      allowSuffixStrippedMatch: true
    }
  )

  if (!coverArtUrl) return { status: 'not_found' }
  return {
    status: 'hit',
    url: coverArtUrl
  }
}

async function resolveCoverArtFromItunesTrackSearch(
  albumCandidates: readonly string[],
  artist: string | null,
  title: string,
  titleCandidates: readonly string[] = [title]
): Promise<DiscordCoverArtLookupResult> {
  const term = artist ? `${title} ${artist}` : title
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'song',
    limit: String(ITUNES_TRACK_SEARCH_LIMIT)
  })

  const response = await fetchJson<ItunesTrackSearchResponse>(
    `${ITUNES_SEARCH_URL}?${params.toString()}`,
    {
      Accept: 'application/json',
      'User-Agent': MUSICBRAINZ_USER_AGENT
    }
  )

  if (response.kind === 'http_error') {
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        code: `itunes_track_http_${response.status}`
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      code: resolveTransientCode('itunes_track', response)
    }
  }

  const results = Array.isArray(response.payload.results) ? response.payload.results : null
  if (!results) {
    return {
      status: 'transient_error',
      code: 'itunes_track_invalid_payload'
    }
  }
  if (results.length === 0) return { status: 'not_found' }

  const targetArtists = artist ? [artist] : []
  const coverCandidates = results.map((entry) => ({
    album: normalizeText(entry.collectionName),
    title: normalizeText(entry.trackName),
    artist: normalizeText(entry.artistName),
    url: selectItunesCoverUrl(entry)
  }))
  const albumCoverArtUrl = chooseBestCoverCandidate(
    coverCandidates,
    albumCandidates,
    targetArtists,
    {
      requireArtistMatch: targetArtists.length > 0,
      allowSuffixStrippedMatch: true
    }
  )
  if (albumCoverArtUrl) {
    return {
      status: 'hit',
      url: albumCoverArtUrl
    }
  }

  const trackCoverArtUrl = chooseBestTrackCoverCandidate(
    coverCandidates,
    titleCandidates,
    targetArtists,
    {
      requireArtistMatch: targetArtists.length > 0
    }
  )
  if (!trackCoverArtUrl) return { status: 'not_found' }
  return {
    status: 'hit',
    url: trackCoverArtUrl
  }
}

function selectTheAudioDbCoverUrl(entry: TheAudioDbAlbum): string | null {
  const thumbHq = normalizeUrlOrNull(entry.strAlbumThumbHQ)
  if (thumbHq) return thumbHq
  return normalizeUrlOrNull(entry.strAlbumThumb)
}

async function resolveCoverArtFromTheAudioDbSearch(
  album: string,
  artist: string | null,
  albumCandidates: readonly string[] = [album]
): Promise<DiscordCoverArtLookupResult> {
  const params = new URLSearchParams({
    a: album
  })
  if (artist) {
    params.set('s', artist)
  }

  const response = await fetchJson<TheAudioDbLookupResponse>(
    `${THE_AUDIO_DB_SEARCH_ALBUM_URL}?${params.toString()}`,
    {
      Accept: 'application/json',
      'User-Agent': MUSICBRAINZ_USER_AGENT
    }
  )

  if (response.kind === 'http_error') {
    if (isTransientHttpStatus(response.status)) {
      return {
        status: 'transient_error',
        code: `theaudiodb_http_${response.status}`
      }
    }
    return { status: 'not_found' }
  }

  if (response.kind !== 'ok') {
    return {
      status: 'transient_error',
      code: resolveTransientCode('theaudiodb', response)
    }
  }

  if (response.payload.album == null) return { status: 'not_found' }
  const results = Array.isArray(response.payload.album) ? response.payload.album : null
  if (!results) {
    return {
      status: 'transient_error',
      code: 'theaudiodb_invalid_payload'
    }
  }
  if (results.length === 0) return { status: 'not_found' }

  const targetArtists = artist ? [artist] : []
  const coverArtUrl = chooseBestCoverCandidate(
    results.map((entry) => ({
      album: normalizeText(entry.strAlbum),
      artist: normalizeText(entry.strArtist),
      url: selectTheAudioDbCoverUrl(entry)
    })),
    albumCandidates,
    targetArtists,
    {
      requireArtistMatch: targetArtists.length > 0,
      allowSuffixStrippedMatch: true
    }
  )

  if (!coverArtUrl) return { status: 'not_found' }
  return {
    status: 'hit',
    url: coverArtUrl
  }
}

async function resolveCoverArtWithMusicBrainzAndCoverArtArchive(
  albumCandidates: readonly string[],
  artistCandidates: string[]
): Promise<ProviderResolutionResult> {
  const releaseCandidates: ReleaseIdCandidate[] = []
  const seenReleaseIds = new Set<string>()
  let transientErrorCode: string | undefined
  const allowArtistlessFallback = artistCandidates.length === 0

  for (const albumCandidate of albumCandidates) {
    for (const artistCandidate of artistCandidates) {
      const candidateResult = await resolveReleaseCandidates(albumCandidate, artistCandidate, albumCandidates)
      if (candidateResult.status === 'transient_error') {
        transientErrorCode = transientErrorCode ?? candidateResult.code
        continue
      }
      if (candidateResult.status === 'not_found') continue
      pushUniqueReleaseIds(releaseCandidates, candidateResult.releaseIds, albumCandidate, seenReleaseIds)
    }

    if (allowArtistlessFallback) {
      const albumOnlyCandidates = await resolveReleaseCandidates(albumCandidate, null, albumCandidates)
      if (albumOnlyCandidates.status === 'transient_error') {
        transientErrorCode = transientErrorCode ?? albumOnlyCandidates.code
      } else if (albumOnlyCandidates.status === 'ok') {
        pushUniqueReleaseIds(releaseCandidates, albumOnlyCandidates.releaseIds, albumCandidate, seenReleaseIds)
      }
    }
  }

  if (releaseCandidates.length === 0) {
    if (transientErrorCode) {
      return {
        result: {
          status: 'transient_error',
          code: transientErrorCode
        },
        candidateCount: 0
      }
    }
    return {
      result: { status: 'not_found' },
      candidateCount: 0
    }
  }

  const candidatesToProbe = releaseCandidates.slice(0, MAX_RELEASE_CANDIDATES_TO_PROBE)
  for (const releaseCandidate of candidatesToProbe) {
    const coverResult = await resolveCoverArtForRelease(releaseCandidate.id)
    if (coverResult.status === 'hit') {
      return {
        result: coverResult,
        candidateCount: candidatesToProbe.length,
        hitCandidate: releaseCandidate.albumCandidate,
        hitPhase: 'release'
      }
    }
    if (coverResult.status === 'transient_error') {
      transientErrorCode = transientErrorCode ?? coverResult.code
    }
  }

  if (transientErrorCode) {
    return {
      result: {
        status: 'transient_error',
        code: transientErrorCode
      },
      candidateCount: candidatesToProbe.length
    }
  }

  return {
    result: { status: 'not_found' },
    candidateCount: candidatesToProbe.length
  }
}

async function resolveCoverArtWithItunes(
  albumCandidates: readonly string[],
  artistCandidates: string[],
  titleCandidates: readonly string[]
): Promise<ProviderResolutionResult> {
  let transientErrorCode: string | undefined
  let queryCount = 0
  const allowArtistlessFallback = artistCandidates.length === 0

  for (const albumCandidate of albumCandidates) {
    for (const artistCandidate of artistCandidates) {
      queryCount += 1
      const result = await resolveCoverArtFromItunesSearch(albumCandidate, artistCandidate, albumCandidates)
      if (result.status === 'hit') {
        return {
          result,
          candidateCount: queryCount,
          hitCandidate: albumCandidate,
          hitPhase: 'album'
        }
      }
      if (result.status === 'transient_error') {
        transientErrorCode = transientErrorCode ?? result.code
      }
    }
  }

  if (titleCandidates.length > 0) {
    for (const titleCandidate of titleCandidates) {
      for (const artistCandidate of artistCandidates) {
        queryCount += 1
        const result = await resolveCoverArtFromItunesTrackSearch(
          albumCandidates,
          artistCandidate,
          titleCandidate,
          titleCandidates
        )
        if (result.status === 'hit') {
          return {
            result,
            candidateCount: queryCount,
            hitCandidate: titleCandidate,
            hitPhase: 'track'
          }
        }
        if (result.status === 'transient_error') {
          transientErrorCode = transientErrorCode ?? result.code
        }
      }
    }
  }

  if (!allowArtistlessFallback) {
    if (transientErrorCode) {
      return {
        result: {
          status: 'transient_error',
          code: transientErrorCode
        },
        candidateCount: queryCount
      }
    }
    return {
      result: { status: 'not_found' },
      candidateCount: queryCount
    }
  }

  for (const albumCandidate of albumCandidates) {
    queryCount += 1
    const albumOnlyResult = await resolveCoverArtFromItunesSearch(albumCandidate, null, albumCandidates)
    if (albumOnlyResult.status === 'hit') {
      return {
        result: albumOnlyResult,
        candidateCount: queryCount,
        hitCandidate: albumCandidate,
        hitPhase: 'album'
      }
    }
    if (albumOnlyResult.status === 'transient_error') {
      transientErrorCode = transientErrorCode ?? albumOnlyResult.code
    }
  }

  if (titleCandidates.length > 0) {
    for (const titleCandidate of titleCandidates) {
      queryCount += 1
      const trackOnlyResult = await resolveCoverArtFromItunesTrackSearch(
        albumCandidates,
        null,
        titleCandidate,
        titleCandidates
      )
      if (trackOnlyResult.status === 'hit') {
        return {
          result: trackOnlyResult,
          candidateCount: queryCount,
          hitCandidate: titleCandidate,
          hitPhase: 'track'
        }
      }
      if (trackOnlyResult.status === 'transient_error') {
        transientErrorCode = transientErrorCode ?? trackOnlyResult.code
      }
    }
  }

  if (transientErrorCode) {
    return {
      result: {
        status: 'transient_error',
        code: transientErrorCode
      },
      candidateCount: queryCount
    }
  }

  return {
    result: { status: 'not_found' },
    candidateCount: queryCount
  }
}

async function resolveCoverArtWithTheAudioDb(
  albumCandidates: readonly string[],
  artistCandidates: string[]
): Promise<ProviderResolutionResult> {
  let transientErrorCode: string | undefined
  let queryCount = 0
  const allowArtistlessFallback = artistCandidates.length === 0

  for (const albumCandidate of albumCandidates) {
    for (const artistCandidate of artistCandidates) {
      queryCount += 1
      const result = await resolveCoverArtFromTheAudioDbSearch(albumCandidate, artistCandidate, albumCandidates)
      if (result.status === 'hit') {
        return {
          result,
          candidateCount: queryCount,
          hitCandidate: albumCandidate,
          hitPhase: 'album'
        }
      }
      if (result.status === 'transient_error') {
        transientErrorCode = transientErrorCode ?? result.code
      }
    }
  }

  if (!allowArtistlessFallback) {
    if (transientErrorCode) {
      return {
        result: {
          status: 'transient_error',
          code: transientErrorCode
        },
        candidateCount: queryCount
      }
    }
    return {
      result: { status: 'not_found' },
      candidateCount: queryCount
    }
  }

  for (const albumCandidate of albumCandidates) {
    queryCount += 1
    const albumOnlyResult = await resolveCoverArtFromTheAudioDbSearch(albumCandidate, null, albumCandidates)
    if (albumOnlyResult.status === 'hit') {
      return {
        result: albumOnlyResult,
        candidateCount: queryCount,
        hitCandidate: albumCandidate,
        hitPhase: 'album'
      }
    }
    if (albumOnlyResult.status === 'transient_error') {
      transientErrorCode = transientErrorCode ?? albumOnlyResult.code
    }
  }

  if (transientErrorCode) {
    return {
      result: {
        status: 'transient_error',
        code: transientErrorCode
      },
      candidateCount: queryCount
    }
  }

  return {
    result: { status: 'not_found' },
    candidateCount: queryCount
  }
}

function pushUniqueReleaseIds(
  target: ReleaseIdCandidate[],
  source: string[],
  albumCandidate: string,
  seen: Set<string>
): void {
  for (const releaseId of source) {
    if (seen.has(releaseId)) continue
    seen.add(releaseId)
    target.push({
      id: releaseId,
      albumCandidate
    })
  }
}

function hasKnownArtistHint(trackArtist: string | null, albumArtist: string | null): boolean {
  if (trackArtist && !isUnknownMetadata(trackArtist, 'artist')) return true
  if (albumArtist && !isUnknownMetadata(albumArtist, 'artist')) return true
  return false
}

const GENERIC_ALBUM_KEYS = new Set([
  'greatest hits',
  'best of',
  'the best of',
  'greatest hits vol 1',
  'greatest hits vol 2',
  'untitled',
  'self titled',
  'debut',
  'compilation',
  'singles',
  'remixes',
  'live',
  'the collection',
  'hits',
  'gold'
])

function isSpecificEnoughAlbumForArtistlessLookup(album: string): boolean {
  const normalized = normalizeMatchKey(album)
  if (!normalized) return false
  const wordCount = normalized.split(' ').filter(Boolean).length
  if (wordCount < 2) return false
  return !GENERIC_ALBUM_KEYS.has(normalized)
}

export async function resolveDiscordCoverArtUrl(query: DiscordCoverArtLookupQuery): Promise<DiscordCoverArtLookupResult> {
  const album = normalizeText(query.album)
  const trackArtist = normalizeText(query.artist)
  const albumArtist = normalizeText(query.albumArtist)
  const title = normalizeText(query.title)
  if (!album) return { status: 'not_found' }
  if (isUnknownMetadata(album, 'album')) return { status: 'not_found' }
  const knownArtistHint = hasKnownArtistHint(trackArtist, albumArtist)
  if (!knownArtistHint && !isSpecificEnoughAlbumForArtistlessLookup(album)) return { status: 'not_found' }

  const artistCandidates = resolveLookupArtistCandidates(trackArtist, albumArtist)
  const albumCandidates = buildCoverArtAlbumCandidates(album, title)
  const titleCandidates = buildCoverArtTitleCandidates(title)
  if (albumCandidates.length === 0) return { status: 'not_found' }
  const logArtist = pickLookupLogArtist(trackArtist, albumArtist, artistCandidates)
  const logKey = toLogKey(album, logArtist)
  let transientErrorCode: string | undefined

  const providerResolvers = [
    {
      name: 'itunes',
      resolve: () => resolveCoverArtWithItunes(albumCandidates, artistCandidates, titleCandidates)
    },
    {
      name: 'musicbrainz_caa',
      resolve: () => resolveCoverArtWithMusicBrainzAndCoverArtArchive(albumCandidates, artistCandidates)
    },
    {
      name: 'theaudiodb',
      resolve: () => resolveCoverArtWithTheAudioDb(albumCandidates, artistCandidates)
    }
  ] as const

  for (const providerResolver of providerResolvers) {
    const providerResult = await providerResolver.resolve()
    const result = providerResult.result

    logLookup(`provider-${providerResolver.name}`, logKey, {
      album,
      albumCandidates,
      artist: logArtist,
      artistCandidates,
      status: result.status,
      code: result.status === 'transient_error' ? result.code : undefined,
      candidateCount: providerResult.candidateCount,
      hitCandidate: providerResult.hitCandidate,
      hitPhase: providerResult.hitPhase
    })

    if (result.status === 'hit') {
      logLookup('lookup-hit', logKey, {
        album,
        albumCandidates,
        artist: logArtist,
        artistCandidates,
        provider: providerResolver.name,
        candidateCount: providerResult.candidateCount,
        hitCandidate: providerResult.hitCandidate,
        hitPhase: providerResult.hitPhase
      })
      return result
    }

    if (result.status === 'transient_error') {
      transientErrorCode = transientErrorCode ?? result.code ?? `${providerResolver.name}_transient_error`
    }
  }

  if (transientErrorCode) {
    logLookup('lookup-transient', logKey, {
      album,
      albumCandidates,
      artist: logArtist,
      artistCandidates,
      providerCount: providerResolvers.length,
      code: transientErrorCode
    })
    return {
      status: 'transient_error',
      code: transientErrorCode
    }
  }

  logLookup('lookup-not-found', logKey, {
    album,
    albumCandidates,
    artist: logArtist,
    artistCandidates,
    providerCount: providerResolvers.length
  })
  return { status: 'not_found' }
}
