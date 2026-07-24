#!/usr/bin/env node
//
// EXAMPLE converter: Last.fm scrobbles -> Astra listening import file.
//
// This is a worked reference for ../listening-import-format.md, not a supported tool. It
// exists to show the shape of a converter and the judgement calls one has to make; adapt it
// rather than depending on it. Astra does not ship converters.
//
//   node docs/examples/lastfm-to-astra.mjs scrobbles.json astra-lastfm.json
//
// Input is a JSON array of scrobbles:
//
//   [{ "artist": "...", "track": "...", "album": "...", "uts": 1750000000 }]
//
// `uts` is Last.fm's timestamp in SECONDS (the date.uts field of user.getRecentTracks, or
// the uts column of most CSV exports). `album` and `durationSeconds` are optional.
//
// Import the result from Settings -> Info -> Imported Listening Data, and remove it again
// from the same place if the numbers come out wrong.

import { readFileSync, writeFileSync } from 'node:fs'

// Last.fm scrobbles at half the track or 4 minutes, whichever comes first, and never records
// how long you actually listened. Duration is an estimate; see the clamp below.
const ASSUMED_TRACK_SECONDS = 210
const EARLIEST_PLAUSIBLE_MS = 946684800000

const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const IDENTITY_SEPARATOR = ''

function convert(scrobbles) {
  const trackIndexByKey = new Map()
  const tracks = []
  const indexOf = (title, artist, album) => {
    const key = [title, artist, album].join(IDENTITY_SEPARATOR).toLowerCase()
    const existing = trackIndexByKey.get(key)
    if (existing !== undefined) return existing
    const index = tracks.length
    tracks.push([title, artist, album, ''])
    trackIndexByKey.set(key, index)
    return index
  }

  // Oldest first, so each scrobble can see the one that follows it.
  const rows = scrobbles
    .map((raw) => ({
      title: norm(raw.track ?? raw.name ?? raw.title),
      artist: norm(raw.artist),
      album: norm(raw.album),
      uts: Number(raw.uts ?? raw.timestamp ?? raw.date),
      duration: Number(raw.durationSeconds) > 0 ? Number(raw.durationSeconds) : ASSUMED_TRACK_SECONDS
    }))
    .filter((row) => row.title && row.artist && Number.isFinite(row.uts) && row.uts > 0)
    .sort((a, b) => a.uts - b.uts)

  const events = []
  const playCounts = new Map()
  const lastPlayed = new Map()

  rows.forEach((row, i) => {
    // Last.fm is in SECONDS, Astra in MILLISECONDS. Astra rejects a file that is entirely in
    // seconds, but checking here catches a mixed-unit source with a useful message.
    const startedAt = Math.round(row.uts * 1000)
    if (startedAt < EARLIEST_PLAUSIBLE_MS || startedAt > Date.now() + 86400000) {
      throw new Error(`implausible timestamp for "${row.title}": ${new Date(startedAt).toISOString()}`)
    }

    // Cap the guessed duration at the gap to the next scrobble. One person cannot play two
    // things at once, so an overlap would only ever be evidence that the guess ran long --
    // and Astra would then report more listening time than actually elapsed.
    const next = rows[i + 1]
    const gapSeconds = next ? next.uts - row.uts : Number.POSITIVE_INFINITY
    const listenedSeconds = Math.max(1, Math.min(row.duration, gapSeconds))

    const trackIndex = indexOf(row.title, row.artist, row.album)
    // Stable across runs because it is derived from the data, never a counter or a random
    // value. This is what makes re-importing merge instead of duplicate.
    const playKey = `lastfm-${row.uts}`

    events.push([trackIndex, playKey, startedAt, startedAt + listenedSeconds * 1000, listenedSeconds, true])
    playCounts.set(trackIndex, (playCounts.get(trackIndex) ?? 0) + 1)
    lastPlayed.set(trackIndex, Math.max(lastPlayed.get(trackIndex) ?? 0, startedAt))
  })

  return {
    kind: 'astra-listening-import',
    formatVersion: 1,
    // Names the service, not this tool -- it is the key the import is removed by.
    source: 'lastfm',
    generator: 'lastfm-to-astra 1.0',
    generatedAt: new Date().toISOString(),
    tracks,
    plays: [...playCounts.entries()].map(([index, count]) => [index, count, lastPlayed.get(index) ?? null]),
    events
  }
}

const [inputPath, outputPath = 'astra-lastfm.json'] = process.argv.slice(2)
if (!inputPath) {
  console.error('usage: node lastfm-to-astra.mjs <scrobbles.json> [output.json]')
  process.exit(1)
}

const file = convert(JSON.parse(readFileSync(inputPath, 'utf-8')))
writeFileSync(outputPath, JSON.stringify(file), 'utf-8')
console.log(`${file.events.length} listens, ${file.tracks.length} tracks -> ${outputPath}`)
