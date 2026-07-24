// Listening stats ride inside the settings transfer file (renderer/utils/settingsTransfer.ts)
// as a pre-serialized compact JSON string under `values.encoded`. That indirection is
// deliberate: the settings file is pretty-printed with 2-space indent, which would inflate
// tens of thousands of session rows past the 10 MB fs:writeTextFile cap. Nesting a compact
// string costs ~3% for quote escaping and keeps the rest of the file readable.
//
// Rows are tuples referencing a shared track dictionary rather than self-describing objects,
// because sessions replay a small distinct track set — the dictionary is the dominant size
// lever. Everything here is pure so it can be unit-tested without a database.

export const LISTENING_STATS_TRANSFER_VERSION = 2

/**
 * [pathHash, pathFoldHash, title, artist, album, albumArtist]
 *
 * Paths travel hashed, never in the clear: an absolute path discloses the account name and
 * library layout to anyone the file is shared with. The hashes still give same-machine
 * restores an exact match (hash the local path and compare); across machines they simply
 * miss and resolution falls through to the metadata tiers, which is the intended path.
 */
export type StatsTransferTrackTuple = [string, string, string, string, string, string]
/** [trackIndex, originIndex, playCount, lastPlayedAt|null] */
export type StatsTransferPlayTuple = [number, number, number, number | null]
/** [trackIndex, rating, updatedAt] */
export type StatsTransferRatingTuple = [number, number, number]
/** [trackIndex, addedAt] */
export type StatsTransferFavoriteTuple = [number, number]
/** [trackIndex, sessionKey, sourceType, durationSeconds, startedAt, endedAt|null, listenedSeconds, qualifiedAt|null] */
export type StatsTransferSessionTuple =
  [number, string, string, number, number, number | null, number, number | null]
/** [sessionIndex, segmentKey, startedAt, lastObservedAt, endedAt|null, listenedSeconds] */
export type StatsTransferSegmentTuple = [number, string, number, number, number | null, number]

export interface ListeningCountsPayload {
  v: typeof LISTENING_STATS_TRANSFER_VERSION
  tracks: StatsTransferTrackTuple[]
  /**
   * Opaque install ids. Play counts are stored per originating install so they can be
   * summed across machines while staying idempotent on re-import: merging takes the MAX
   * for each origin separately, and the displayed count is the sum over origins. A plain
   * total could not do both — re-importing the same file would double it.
   */
  origins: string[]
  plays: StatsTransferPlayTuple[]
  ratings: StatsTransferRatingTuple[]
  favorites: StatsTransferFavoriteTuple[]
}

export interface ListeningHistoryPayload {
  v: typeof LISTENING_STATS_TRANSFER_VERSION
  historyStartedAt: number | null
  sessionsTotal: number
  truncated: boolean
  tracks: StatsTransferTrackTuple[]
  sessions: StatsTransferSessionTuple[]
  segments: StatsTransferSegmentTuple[]
}

export interface StatsTransferTrackIdentity {
  pathHash: string
  pathFoldHash: string
  title: string
  artist: string
  album: string
  albumArtist: string
}

export type StatsTransferDecodeResult<T> =
  | { ok: true; payload: T }
  | { ok: false; error: string }

export interface ListeningStatsImportResult {
  countsApplied: boolean
  historyApplied: boolean

  identitiesInPayload: number
  identitiesMatched: number
  identitiesUnmatched: number
  identitiesAmbiguous: number

  playCountsUpdated: number
  ratingsApplied: number
  ratingsKeptLocal: number
  favoritesAdded: number
  favoritesAlreadyPresent: number
  favoriteTombstonesCleared: number

  sessionsInserted: number
  sessionsMerged: number
  sessionsSkipped: number
  segmentsInserted: number
  segmentsMerged: number
  sessionsTruncatedAtExport: boolean
  historyStartedAtMovedTo: number | null
}

export function createEmptyListeningStatsImportResult(): ListeningStatsImportResult {
  return {
    countsApplied: false,
    historyApplied: false,
    identitiesInPayload: 0,
    identitiesMatched: 0,
    identitiesUnmatched: 0,
    identitiesAmbiguous: 0,
    playCountsUpdated: 0,
    ratingsApplied: 0,
    ratingsKeptLocal: 0,
    favoritesAdded: 0,
    favoritesAlreadyPresent: 0,
    favoriteTombstonesCleared: 0,
    sessionsInserted: 0,
    sessionsMerged: 0,
    sessionsSkipped: 0,
    segmentsInserted: 0,
    segmentsMerged: 0,
    sessionsTruncatedAtExport: false,
    historyStartedAtMovedTo: null
  }
}

// ── Track dictionary ─────────────────────────────────────

const TRACK_IDENTITY_SEPARATOR = '\u001f'

export interface StatsTransferTrackDictionary {
  /** Interns the identity and returns its stable index. */
  indexOf: (identity: StatsTransferTrackIdentity) => number
  tuples: () => StatsTransferTrackTuple[]
  size: () => number
}

export function createStatsTransferTrackDictionary(): StatsTransferTrackDictionary {
  const indexByKey = new Map<string, number>()
  const tuples: StatsTransferTrackTuple[] = []

  return {
    indexOf(identity) {
      const tuple: StatsTransferTrackTuple = [
        toText(identity.pathHash),
        toText(identity.pathFoldHash),
        toText(identity.title),
        toText(identity.artist),
        toText(identity.album),
        toText(identity.albumArtist)
      ]
      // Keyed on the whole tuple rather than the path hash alone: ratings/favorites rows can
      // legitimately reference a path with no track row, and those carry empty metadata.
      const key = tuple.join(TRACK_IDENTITY_SEPARATOR)
      const existing = indexByKey.get(key)
      if (existing !== undefined) return existing
      const index = tuples.length
      tuples.push(tuple)
      indexByKey.set(key, index)
      return index
    },
    tuples() {
      return tuples
    },
    size() {
      return tuples.length
    }
  }
}

// ── Merge primitives (mirror the SQL in library.ts exactly) ──

/**
 * Merges one origin's contribution. MAX rather than addition is what makes re-importing the
 * same file a no-op: an origin's count is a running total from that install, not a delta.
 * Counts from *different* installs add up because they live in separate origin rows —
 * see sumOriginPlayCounts.
 */
export function mergePlayCount(local: number, imported: number): number {
  const localCount = Number.isFinite(local) ? Math.max(0, Math.trunc(local)) : 0
  const importedCount = Number.isFinite(imported) ? Math.max(0, Math.trunc(imported)) : 0
  return Math.max(localCount, importedCount)
}

/** The displayed play count: every install's contribution added together. */
export function sumOriginPlayCounts(counts: Iterable<number>): number {
  let total = 0
  for (const count of counts) {
    if (Number.isFinite(count) && count > 0) total += Math.trunc(count)
  }
  return total
}

export function mergeMaxTimestamp(local: number | null, imported: number | null): number | null {
  if (local === null || !Number.isFinite(local)) return imported === null || !Number.isFinite(imported) ? null : imported
  if (imported === null || !Number.isFinite(imported)) return local
  return Math.max(local, imported)
}

export function mergeMinTimestamp(local: number | null, imported: number | null): number | null {
  if (local === null || !Number.isFinite(local)) return imported === null || !Number.isFinite(imported) ? null : imported
  if (imported === null || !Number.isFinite(imported)) return local
  return Math.min(local, imported)
}

/** Newest write wins; a tie keeps the local value so re-import is a no-op. */
export function shouldReplaceRating(localUpdatedAt: number, importedUpdatedAt: number): boolean {
  if (!Number.isFinite(importedUpdatedAt)) return false
  if (!Number.isFinite(localUpdatedAt)) return true
  return importedUpdatedAt > localUpdatedAt
}

// ── Encoding ─────────────────────────────────────────────

export function encodeListeningCountsPayload(payload: ListeningCountsPayload): string {
  return JSON.stringify(payload)
}

export function encodeListeningHistoryPayload(payload: ListeningHistoryPayload): string {
  return JSON.stringify(payload)
}

// ── Decoding ─────────────────────────────────────────────
//
// This parses a user-supplied file, so it is deliberately lenient about individual rows:
// structural problems are rejected outright, but a single malformed row is dropped rather
// than failing the whole import.

function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  if (parsed === null || parsed < 0) return null
  return parsed
}

function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null
  const parsed = finiteNumber(value)
  if (parsed === null) return undefined
  return parsed
}

function parseEnvelope(encoded: unknown): StatsTransferDecodeResult<Record<string, unknown>> {
  if (typeof encoded !== 'string' || encoded.trim().length === 0) {
    return { ok: false, error: 'This file does not contain any listening data.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return { ok: false, error: 'The listening data in this file could not be read.' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The listening data in this file could not be read.' }
  }

  const record = parsed as Record<string, unknown>
  if (record.v !== LISTENING_STATS_TRANSFER_VERSION) {
    return { ok: false, error: 'This file uses an unsupported listening data version.' }
  }
  if (!Array.isArray(record.tracks)) {
    return { ok: false, error: 'The listening data in this file is missing its track list.' }
  }

  return { ok: true, payload: record }
}

function decodeTrackTuples(value: unknown): StatsTransferTrackTuple[] {
  const tuples: StatsTransferTrackTuple[] = []
  if (!Array.isArray(value)) return tuples
  for (const row of value) {
    if (!Array.isArray(row)) {
      // Keep the index space aligned — a dropped track would shift every reference.
      tuples.push(['', '', '', '', '', ''])
      continue
    }
    tuples.push([
      toText(row[0]),
      toText(row[1]),
      toText(row[2]),
      toText(row[3]),
      toText(row[4]),
      toText(row[5])
    ])
  }
  return tuples
}

function decodeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => toText(entry))
}

function isTrackIndex(value: unknown, trackCount: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < trackCount
}

export function decodeListeningCountsPayload(
  encoded: unknown
): StatsTransferDecodeResult<ListeningCountsPayload> {
  const envelope = parseEnvelope(encoded)
  if (!envelope.ok) return envelope

  const record = envelope.payload
  const tracks = decodeTrackTuples(record.tracks)
  const trackCount = tracks.length
  const origins = decodeOrigins(record.origins)

  // Deduped on (track, origin): the same origin must never contribute twice, or the summed
  // total would exceed what that install actually played.
  const plays: StatsTransferPlayTuple[] = []
  const seenPlayKeys = new Set<string>()
  if (Array.isArray(record.plays)) {
    for (const row of record.plays) {
      if (!Array.isArray(row)) continue
      const [trackIndex, originIndex, playCount, lastPlayedAt] = row
      if (!isTrackIndex(trackIndex, trackCount)) continue
      if (typeof originIndex !== 'number' || !Number.isInteger(originIndex)) continue
      if (originIndex < 0 || originIndex >= origins.length) continue
      if (!origins[originIndex]) continue
      const playKey = `${trackIndex}\u001f${originIndex}`
      if (seenPlayKeys.has(playKey)) continue
      const count = nonNegativeNumber(playCount)
      const played = optionalTimestamp(lastPlayedAt)
      if (count === null || played === undefined) continue
      if (count === 0 && played === null) continue
      seenPlayKeys.add(playKey)
      plays.push([trackIndex, originIndex, Math.trunc(count), played])
    }
  }

  const ratings: StatsTransferRatingTuple[] = []
  const seenRatingIndices = new Set<number>()
  if (Array.isArray(record.ratings)) {
    for (const row of record.ratings) {
      if (!Array.isArray(row)) continue
      const [trackIndex, rating, updatedAt] = row
      if (!isTrackIndex(trackIndex, trackCount)) continue
      if (seenRatingIndices.has(trackIndex)) continue
      const ratingValue = finiteNumber(rating)
      const updated = nonNegativeNumber(updatedAt)
      if (ratingValue === null || updated === null) continue
      seenRatingIndices.add(trackIndex)
      ratings.push([trackIndex, ratingValue, updated])
    }
  }

  const favorites: StatsTransferFavoriteTuple[] = []
  const seenFavoriteIndices = new Set<number>()
  if (Array.isArray(record.favorites)) {
    for (const row of record.favorites) {
      if (!Array.isArray(row)) continue
      const [trackIndex, addedAt] = row
      if (!isTrackIndex(trackIndex, trackCount)) continue
      if (seenFavoriteIndices.has(trackIndex)) continue
      const added = nonNegativeNumber(addedAt)
      if (added === null) continue
      seenFavoriteIndices.add(trackIndex)
      favorites.push([trackIndex, added])
    }
  }

  return {
    ok: true,
    payload: { v: LISTENING_STATS_TRANSFER_VERSION, tracks, origins, plays, ratings, favorites }
  }
}

export function decodeListeningHistoryPayload(
  encoded: unknown
): StatsTransferDecodeResult<ListeningHistoryPayload> {
  const envelope = parseEnvelope(encoded)
  if (!envelope.ok) return envelope

  const record = envelope.payload
  const tracks = decodeTrackTuples(record.tracks)
  const trackCount = tracks.length

  // Sessions are deduped by key, keeping the max-merged row, so a hand-edited file with
  // repeated keys imports the same way the SQL upsert would have merged them.
  const sessionByKey = new Map<string, StatsTransferSessionTuple>()
  if (Array.isArray(record.sessions)) {
    for (const row of record.sessions) {
      if (!Array.isArray(row)) continue
      const [trackIndex, sessionKey, sourceType, duration, startedAt, endedAt, listened, qualifiedAt] = row
      if (!isTrackIndex(trackIndex, trackCount)) continue
      const key = toText(sessionKey).trim()
      if (key.length === 0) continue
      const durationSeconds = nonNegativeNumber(duration)
      const started = finiteNumber(startedAt)
      const listenedSeconds = nonNegativeNumber(listened)
      const ended = optionalTimestamp(endedAt)
      const qualified = optionalTimestamp(qualifiedAt)
      if (durationSeconds === null || started === null || listenedSeconds === null) continue
      if (ended === undefined || qualified === undefined) continue

      const candidate: StatsTransferSessionTuple = [
        trackIndex, key, toText(sourceType), durationSeconds, started, ended, listenedSeconds, qualified
      ]
      const existing = sessionByKey.get(key)
      sessionByKey.set(key, existing ? mergeSessionTuples(existing, candidate) : candidate)
    }
  }

  const sessions = Array.from(sessionByKey.values())
  const sessionIndexByKey = new Map<string, number>()
  sessions.forEach((session, index) => {
    sessionIndexByKey.set(session[1], index)
  })

  // Segment indices refer to positions in the *original* session array. Dedupe collapsed it,
  // so remap through the session key before validating.
  const originalSessionKeys: string[] = []
  if (Array.isArray(record.sessions)) {
    for (const row of record.sessions) {
      originalSessionKeys.push(Array.isArray(row) ? toText(row[1]).trim() : '')
    }
  }

  const segmentByKey = new Map<string, StatsTransferSegmentTuple>()
  if (Array.isArray(record.segments)) {
    for (const row of record.segments) {
      if (!Array.isArray(row)) continue
      const [rawSessionIndex, segmentKey, startedAt, lastObservedAt, endedAt, listened] = row
      if (typeof rawSessionIndex !== 'number' || !Number.isInteger(rawSessionIndex)) continue
      if (rawSessionIndex < 0 || rawSessionIndex >= originalSessionKeys.length) continue
      const sessionIndex = sessionIndexByKey.get(originalSessionKeys[rawSessionIndex])
      if (sessionIndex === undefined) continue

      const key = toText(segmentKey).trim()
      if (key.length === 0) continue
      const started = finiteNumber(startedAt)
      const lastObserved = finiteNumber(lastObservedAt)
      const listenedSeconds = nonNegativeNumber(listened)
      const ended = optionalTimestamp(endedAt)
      if (started === null || lastObserved === null || listenedSeconds === null) continue
      if (ended === undefined) continue

      const candidate: StatsTransferSegmentTuple = [
        sessionIndex, key, started, lastObserved, ended, listenedSeconds
      ]
      const dedupeKey = `${sessionIndex}\u001f${key}`
      const existing = segmentByKey.get(dedupeKey)
      segmentByKey.set(dedupeKey, existing ? mergeSegmentTuples(existing, candidate) : candidate)
    }
  }

  const sessionsTotal = nonNegativeNumber(record.sessionsTotal)

  return {
    ok: true,
    payload: {
      v: LISTENING_STATS_TRANSFER_VERSION,
      historyStartedAt: finiteNumber(record.historyStartedAt),
      sessionsTotal: sessionsTotal === null ? sessions.length : Math.trunc(sessionsTotal),
      truncated: record.truncated === true,
      tracks,
      sessions,
      segments: Array.from(segmentByKey.values())
    }
  }
}

function mergeSessionTuples(
  a: StatsTransferSessionTuple,
  b: StatsTransferSessionTuple
): StatsTransferSessionTuple {
  return [
    a[0],
    a[1],
    a[2] || b[2],
    Math.max(a[3], b[3]),
    Math.min(a[4], b[4]),
    mergeMaxTimestamp(a[5], b[5]),
    Math.max(a[6], b[6]),
    mergeMinTimestamp(a[7], b[7])
  ]
}

function mergeSegmentTuples(
  a: StatsTransferSegmentTuple,
  b: StatsTransferSegmentTuple
): StatsTransferSegmentTuple {
  return [
    a[0],
    a[1],
    Math.min(a[2], b[2]),
    Math.max(a[3], b[3]),
    mergeMaxTimestamp(a[4], b[4]),
    Math.max(a[5], b[5])
  ]
}
