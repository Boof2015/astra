// The public listening-import format: how an external tool hands Astra listening data it
// gathered somewhere else (a Last.fm history, another player's database, a spreadsheet).
//
// This is deliberately NOT the settings-transfer format. That one is Astra talking to
// itself and carries internal details — path digests, per-install origin ids, source types —
// that a third-party tool has no business inventing. Here those are all derived:
//
//   * every play is attributed to `import:<source>`, so a file cannot claim to be another
//     Astra install and overwrite its counts;
//   * every session key is namespaced with the same prefix, so a file cannot collide with
//     (and corrupt) a real locally recorded session;
//   * the source tag is mandatory, which is what makes an import removable afterwards.
//
// Everything a converter writes is plain, self-describing JSON. Timestamps are epoch
// MILLISECONDS. See docs/listening-import-format.md for the authoring guide.

export const LISTENING_IMPORT_KIND = 'astra-listening-import'
export const LISTENING_IMPORT_FORMAT_VERSION = 1

/** [title, artist, album, albumArtist] — albumArtist may be empty. */
export type ImportTrackTuple = [string, string, string, string]
/** [trackIndex, playCount, lastPlayedAt|null] */
export type ImportPlayTuple = [number, number, number | null]
/** [trackIndex, playKey, startedAt, endedAt|null, listenedSeconds, countsAsPlay] */
export type ImportPlayEventTuple = [number, string, number, number | null, number, boolean]

export interface ListeningImportFile {
  kind: typeof LISTENING_IMPORT_KIND
  formatVersion: typeof LISTENING_IMPORT_FORMAT_VERSION
  /**
   * Where the data came from, as a slug: lowercase letters, digits and hyphens. Becomes the
   * label in Settings and the key the whole import is removed by, so it should identify the
   * service rather than the tool — "lastfm", not "steves-converter-v2".
   */
  source: string
  /** Free text naming the tool, shown when something goes wrong. */
  generator: string
  generatedAt: string
  tracks: ImportTrackTuple[]
  plays: ImportPlayTuple[]
  /** Individual listens. Required for any listening-time or activity-chart figure. */
  events: ImportPlayEventTuple[]
}

export type ListeningImportParseResult =
  | { ok: true; file: ListeningImportFile; warnings: string[] }
  | { ok: false; error: string }

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_SOURCE_LENGTH = 32

export function isValidImportSource(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_PATTERN.test(value)
}

/** The origin these plays are recorded under, and the key they are removed by. */
export function importOriginId(source: string): string {
  return `import:${source}`
}

/**
 * Namespaces a converter's own key so it can never collide with a locally recorded session.
 * The key only has to be stable across runs of the converter — that is what makes importing
 * the same file twice a no-op instead of a duplicate.
 */
export function importSessionKey(source: string, playKey: string): string {
  return `import:${source}:${playKey}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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
  if (value === null || value === undefined) return null
  const parsed = finiteNumber(value)
  if (parsed === null) return undefined
  return parsed
}

// A timestamp in seconds instead of milliseconds is the single most common converter bug,
// and it fails silently — everything lands in January 1970 and the Stats page looks broken.
// Rather than let that through, anything outside a plausible window is rejected with an
// explanation. 2000-01-01 through roughly a day into the future.
const EARLIEST_PLAUSIBLE_MS = 946_684_800_000
const FUTURE_TOLERANCE_MS = 86_400_000

function isPlausibleTimestamp(value: number, now: number): boolean {
  return value >= EARLIEST_PLAUSIBLE_MS && value <= now + FUTURE_TOLERANCE_MS
}

export interface ParseListeningImportOptions {
  now?: number
  /** Caps how many warnings are collected; parsing itself is unbounded. */
  maxWarnings?: number
}

export function parseListeningImportFile(
  content: string,
  options: ParseListeningImportOptions = {}
): ListeningImportParseResult {
  const now = options.now ?? Date.now()
  const maxWarnings = options.maxWarnings ?? 20
  const warnings: string[] = []
  const warn = (message: string): void => {
    if (warnings.length < maxWarnings) warnings.push(message)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' }
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: 'This file is not an Astra listening import.' }
  }
  if (parsed.kind !== LISTENING_IMPORT_KIND) {
    return { ok: false, error: 'This file is not an Astra listening import.' }
  }
  if (parsed.formatVersion !== LISTENING_IMPORT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `This file uses listening import format ${String(parsed.formatVersion)}, but this version of Astra reads format ${LISTENING_IMPORT_FORMAT_VERSION}.`
    }
  }
  if (!isValidImportSource(parsed.source)) {
    return {
      ok: false,
      error: 'This file is missing a valid "source" tag (lowercase letters, digits and hyphens, up to '
        + `${MAX_SOURCE_LENGTH} characters). Astra needs it to label the import and to remove it later.`
    }
  }
  if (parsed.ratings !== undefined || parsed.favorites !== undefined) {
    warn(
      'Third-party ratings and favorites are not part of the listening import format and were ignored.'
    )
  }

  const tracks: ImportTrackTuple[] = []
  if (!Array.isArray(parsed.tracks)) {
    return { ok: false, error: 'This file is missing its "tracks" list.' }
  }
  for (const row of parsed.tracks) {
    // Index alignment must hold even for a bad row, since every other list points here.
    if (!Array.isArray(row)) {
      tracks.push(['', '', '', ''])
      continue
    }
    tracks.push([toText(row[0]), toText(row[1]), toText(row[2]), toText(row[3])])
  }
  if (tracks.length === 0) {
    return { ok: false, error: 'This file does not list any tracks.' }
  }
  const untitled = tracks.filter((tuple) => !tuple[0].trim()).length
  if (untitled > 0) {
    warn(`${untitled} track entries have no title and cannot be matched to your library.`)
  }

  const isTrackIndex = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < tracks.length

  let droppedTimestamps = 0
  let sawImplausibleTimestamp = false
  const checkTimestamp = (value: number): boolean => {
    if (isPlausibleTimestamp(value, now)) return true
    sawImplausibleTimestamp = true
    droppedTimestamps += 1
    return false
  }

  const plays: ImportPlayTuple[] = []
  const seenPlayTracks = new Set<number>()
  if (Array.isArray(parsed.plays)) {
    for (const row of parsed.plays) {
      if (!Array.isArray(row)) continue
      const [trackIndex, playCount, lastPlayedAt] = row
      if (!isTrackIndex(trackIndex) || seenPlayTracks.has(trackIndex)) continue
      const count = nonNegativeNumber(playCount)
      const played = optionalTimestamp(lastPlayedAt)
      if (count === null || played === undefined) continue
      if (played !== null && !checkTimestamp(played)) continue
      seenPlayTracks.add(trackIndex)
      plays.push([trackIndex, Math.trunc(count), played])
    }
  }

  // Deduped on the converter's own key so a re-run merges rather than duplicating.
  const eventByKey = new Map<string, ImportPlayEventTuple>()
  let overlapping = 0
  let invalidEventEnds = 0
  if (Array.isArray(parsed.events)) {
    const spansByTrack = new Map<number, Array<[number, number]>>()
    for (const row of parsed.events) {
      if (!Array.isArray(row)) continue
      const [trackIndex, playKey, startedAt, endedAt, listenedSeconds, countsAsPlay] = row
      if (!isTrackIndex(trackIndex)) continue
      const key = toText(playKey).trim()
      if (!key) continue
      const started = finiteNumber(startedAt)
      const listened = nonNegativeNumber(listenedSeconds)
      const ended = optionalTimestamp(endedAt)
      if (started === null || listened === null) continue
      if (ended === undefined) {
        invalidEventEnds += 1
        continue
      }
      if (!checkTimestamp(started)) continue
      const resolvedEnd = ended ?? started + Math.round(listened * 1000)
      if (!Number.isFinite(resolvedEnd) || resolvedEnd < started) {
        invalidEventEnds += 1
        continue
      }
      if (!checkTimestamp(resolvedEnd)) {
        invalidEventEnds += 1
        continue
      }

      eventByKey.set(key, [trackIndex, key, started, ended, listened, countsAsPlay !== false])

      // Two listens by one person cannot occupy the same moment. When they do, the
      // converter has guessed durations longer than the gaps between plays, and listening
      // time will read high. Worth telling the user; not worth refusing the import.
      const spans = spansByTrack.get(trackIndex) ?? []
      if (spans.some(([otherStart, otherEnd]) => started < otherEnd && resolvedEnd > otherStart)) {
        overlapping += 1
      }
      spans.push([started, resolvedEnd])
      spansByTrack.set(trackIndex, spans)
    }
  }

  if (sawImplausibleTimestamp) {
    warn(
      `${droppedTimestamps} timestamps were outside a plausible range and were dropped. `
      + 'Astra expects epoch milliseconds — a value in seconds is 1000x too small and lands in 1970.'
    )
  }
  if (invalidEventEnds > 0) {
    warn(
      `${invalidEventEnds} listens had an invalid end time and were dropped. `
      + 'An end time must be epoch milliseconds, no earlier than the listen start.'
    )
  }
  if (overlapping > 0) {
    warn(
      `${overlapping} listens overlap another listen of the same track. `
      + 'Listening time will read higher than real elapsed time; cap each listen at the gap to the next one.'
    )
  }
  if (eventByKey.size === 0 && plays.length > 0) {
    warn('This file has play counts but no listens, so the Stats page will show plays with no listening time.')
  }

  if (plays.length === 0 && eventByKey.size === 0) {
    // A file where every timestamp was in seconds ends up empty here. Say so specifically —
    // it is by far the likeliest reason, and "no usable data" would send an author looking
    // in the wrong place.
    if (sawImplausibleTimestamp) {
      return {
        ok: false,
        error: 'Every timestamp in this file is outside a plausible range, so nothing could be imported. '
          + 'Astra expects epoch milliseconds; a value in seconds is 1000x too small and lands in 1970.'
      }
    }
    if (invalidEventEnds > 0) {
      return {
        ok: false,
        error: 'Every listen in this file has an invalid end time, so nothing could be imported. '
          + 'An end time must be epoch milliseconds, no earlier than the listen start.'
      }
    }
    return { ok: false, error: 'This file does not contain any listening data Astra can use.' }
  }

  return {
    ok: true,
    warnings,
    file: {
      kind: LISTENING_IMPORT_KIND,
      formatVersion: LISTENING_IMPORT_FORMAT_VERSION,
      source: parsed.source,
      generator: toText(parsed.generator),
      generatedAt: toText(parsed.generatedAt),
      tracks,
      plays,
      events: Array.from(eventByKey.values())
    }
  }
}
