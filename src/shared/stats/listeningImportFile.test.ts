import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LISTENING_IMPORT_FORMAT_VERSION,
  LISTENING_IMPORT_KIND,
  importOriginId,
  importSessionKey,
  isValidImportSource,
  parseListeningImportFile
} from './listeningImportFile.ts'

const NOW = 1_750_500_000_000
const T = 1_750_000_000_000

function build(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: LISTENING_IMPORT_KIND,
    formatVersion: LISTENING_IMPORT_FORMAT_VERSION,
    source: 'lastfm',
    generator: 'lastfm-to-astra 1.0',
    generatedAt: '2026-07-24T00:00:00.000Z',
    tracks: [['Teen Intro', 'Jane Remover', 'Teen Week', '']],
    plays: [[0, 4, T]],
    events: [[0, 'p1', T, T + 180_000, 180, true]],
    ...overrides
  })
}

function parse(overrides: Record<string, unknown> = {}) {
  return parseListeningImportFile(build(overrides), { now: NOW })
}

test('a well-formed import file parses', () => {
  const result = parse()
  assert.ok(result.ok)
  assert.equal(result.file.source, 'lastfm')
  assert.deepEqual(result.file.plays, [[0, 4, T]])
  assert.deepEqual(result.file.events, [[0, 'p1', T, T + 180_000, 180, true]])
  assert.deepEqual(result.warnings, [])
})

test('the wrong kind or format version is rejected with an explanation', () => {
  const wrongKind = parseListeningImportFile(JSON.stringify({ kind: 'astra-settings-transfer' }), { now: NOW })
  assert.equal(wrongKind.ok, false)
  assert.ok(!wrongKind.ok)
  assert.match(wrongKind.error, /not an Astra listening import/i)

  const wrongVersion = parse({ formatVersion: 99 })
  assert.equal(wrongVersion.ok, false)
  assert.ok(!wrongVersion.ok)
  // The message names both versions so a converter author knows which way to move.
  assert.match(wrongVersion.error, /format 99/)
  assert.match(wrongVersion.error, new RegExp(`format ${LISTENING_IMPORT_FORMAT_VERSION}`))
})

test('malformed JSON is rejected without throwing', () => {
  const result = parseListeningImportFile('{ not json', { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /not valid JSON/i)
})

test('the source tag is mandatory and must be a slug', () => {
  for (const source of [undefined, null, '', 'Last FM', 'lastfm!', 'A'.repeat(40), '-leading']) {
    const result = parse({ source })
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(source)}`)
    assert.ok(!result.ok)
    assert.match(result.error, /source/i)
  }
  assert.ok(parse({ source: 'last-fm-2' }).ok)
})

test('source validation and derived keys line up', () => {
  assert.equal(isValidImportSource('lastfm'), true)
  assert.equal(isValidImportSource('Last FM'), false)
  assert.equal(importOriginId('lastfm'), 'import:lastfm')
  // Namespacing is what stops a file colliding with a real locally recorded session.
  assert.equal(importSessionKey('lastfm', 'p1'), 'import:lastfm:p1')
})

test('a file entirely in seconds is rejected by naming the actual mistake', () => {
  const seconds = Math.floor(T / 1000)
  const result = parse({
    plays: [[0, 4, seconds]],
    events: [[0, 'p1', seconds, null, 180, true]]
  })

  // Nothing survives, so the import fails — but the message has to point at the unit rather
  // than say "no data", or an author goes looking in entirely the wrong place.
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /milliseconds/i)
  assert.match(result.error, /1970/)
})

test('a partially bad file keeps the good rows and warns about the rest', () => {
  const seconds = Math.floor(T / 1000)
  const result = parse({
    events: [
      [0, 'good', T, T + 180_000, 180, true],
      [0, 'bad', seconds, null, 180, true]
    ]
  })

  assert.ok(result.ok)
  assert.deepEqual(result.file.events.map((event) => event[1]), ['good'])
  assert.ok(result.warnings.some((w) => /milliseconds/i.test(w)), result.warnings.join(' | '))
})

test('far-future timestamps are dropped too', () => {
  const result = parse({ events: [[0, 'p1', NOW + 5 * 86_400_000, null, 180, true]] })
  assert.ok(result.ok)
  assert.deepEqual(result.file.events, [])
})

test('event end times must be plausible and no earlier than their starts', () => {
  const seconds = Math.floor(T / 1000)
  const result = parse({
    events: [
      [0, 'seconds-end', T, seconds, 180, true],
      [0, 'backwards-end', T, T - 1, 180, true],
      [0, 'invalid-end', T, 'not-a-timestamp', 180, true],
      [0, 'inferred-end', T, null, 180, true]
    ]
  })

  assert.ok(result.ok)
  assert.deepEqual(result.file.events.map((event) => event[1]), ['inferred-end'])
  assert.ok(result.warnings.some((warning) => /invalid end time/i.test(warning)), result.warnings.join(' | '))
  assert.ok(result.warnings.some((warning) => /milliseconds/i.test(warning)), result.warnings.join(' | '))
})

test('a null event end derives a plausible end from listened seconds', () => {
  const result = parse({ plays: [], events: [[0, 'inferred', T, null, 180, true]] })
  assert.ok(result.ok)
  assert.deepEqual(result.file.events, [[0, 'inferred', T, null, 180, true]])
})

test('a file containing only invalid event ends names the problem', () => {
  const result = parse({ plays: [], events: [[0, 'backwards', T, T - 1, 180, true]] })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /invalid end time/i)
  assert.match(result.error, /no earlier than the listen start/i)
})

test('overlapping listens are accepted but warned about', () => {
  // Two plays 90s apart each claiming 180s: the classic "assume a full playthrough" bug.
  const result = parse({
    events: [
      [0, 'p1', T, T + 180_000, 180, true],
      [0, 'p2', T + 90_000, T + 270_000, 180, true]
    ]
  })

  assert.ok(result.ok)
  assert.equal(result.file.events.length, 2, 'the import should still go through')
  assert.ok(result.warnings.some((w) => /overlap/i.test(w)), result.warnings.join(' | '))
})

test('sequential listens of the same track are not flagged as overlapping', () => {
  const result = parse({
    events: [
      [0, 'p1', T, T + 180_000, 180, true],
      [0, 'p2', T + 180_000, T + 360_000, 180, true]
    ]
  })
  assert.ok(result.ok)
  assert.deepEqual(result.warnings, [])
})

test('duplicate play keys collapse so a re-run does not duplicate', () => {
  const result = parse({
    events: [
      [0, 'p1', T, T + 180_000, 120, true],
      [0, 'p1', T, T + 180_000, 180, true]
    ]
  })
  assert.ok(result.ok)
  assert.equal(result.file.events.length, 1)
  assert.equal(result.file.events[0][4], 180)
})

test('rows referencing a missing track are dropped, and index alignment survives a bad row', () => {
  const result = parse({
    tracks: [['A', 'Artist', '', ''], 'not an array', ['C', 'Artist', '', '']],
    plays: [[0, 1, T], [2, 3, T], [9, 5, T]],
    events: []
  })
  assert.ok(result.ok)
  assert.equal(result.file.tracks.length, 3, 'a malformed track must still occupy its index')
  assert.deepEqual(result.file.tracks[1], ['', '', '', ''])
  assert.deepEqual(result.file.plays.map((play) => play[0]), [0, 2])
})

test('a file with no usable data is rejected', () => {
  const result = parse({ plays: [], events: [] })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /does not contain any listening data/i)
})

test('legacy ratings and favorites are ignored with a warning', () => {
  const result = parse({
    ratings: [[0, 4.5, T]],
    favorites: [[0, T]]
  })
  assert.ok(result.ok)
  assert.equal('ratings' in result.file, false)
  assert.equal('favorites' in result.file, false)
  assert.ok(result.warnings.some((warning) => /ratings and favorites.*ignored/i.test(warning)))
})

test('a file containing only legacy ratings or favorites is rejected', () => {
  const result = parse({
    plays: [],
    events: [],
    ratings: [[0, 4.5, T]],
    favorites: [[0, T]]
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /does not contain any listening data/i)
})

test('play counts without listens are accepted with a warning about missing time', () => {
  const result = parse({ events: [] })
  assert.ok(result.ok)
  assert.ok(result.warnings.some((w) => /no listening time|no listens/i.test(w)), result.warnings.join(' | '))
})

test('untitled tracks are reported since they cannot match a library', () => {
  const result = parse({
    tracks: [['', 'Jane Remover', 'Teen Week', '']],
    plays: [[0, 1, T]],
    events: []
  })
  assert.ok(result.ok)
  assert.ok(result.warnings.some((w) => /no title/i.test(w)), result.warnings.join(' | '))
})
