import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildTrackListRows, type TrackListDiscTrackLike, type TrackListVirtualRow } from './trackListRows.ts'

function track(discNumber: number | null | undefined): TrackListDiscTrackLike {
  return { disc_number: discNumber }
}

function summarizeRows(rows: readonly TrackListVirtualRow[]): string[] {
  return rows.map((row) => (
    row.kind === 'disc-header'
      ? `disc:${row.discNumber}`
      : `track:${row.trackIndex}`
  ))
}

test('buildTrackListRows inserts headers for multi-disc albums', () => {
  const rows = buildTrackListRows([
    track(1),
    track(1),
    track(2),
    track(2)
  ], true)

  assert.deepEqual(summarizeRows(rows), [
    'disc:1',
    'track:0',
    'track:1',
    'disc:2',
    'track:2',
    'track:3'
  ])
})

test('buildTrackListRows skips headers for untagged or single-disc albums', () => {
  assert.deepEqual(summarizeRows(buildTrackListRows([
    track(null),
    track(undefined),
    track(0)
  ], true)), [
    'track:0',
    'track:1',
    'track:2'
  ])

  assert.deepEqual(summarizeRows(buildTrackListRows([
    track(1),
    track(1)
  ], true)), [
    'track:0',
    'track:1'
  ])
})

test('buildTrackListRows groups missing disc numbers as disc one when later discs exist', () => {
  const rows = buildTrackListRows([
    track(null),
    track(0),
    track(2)
  ], true)

  assert.deepEqual(summarizeRows(rows), [
    'disc:1',
    'track:0',
    'track:1',
    'disc:2',
    'track:2'
  ])
})

test('buildTrackListRows preserves original track indexes', () => {
  const rows = buildTrackListRows([
    track(1),
    track(2),
    track(3)
  ], true)

  assert.deepEqual(
    rows.filter((row): row is Extract<TrackListVirtualRow, { kind: 'track' }> => row.kind === 'track')
      .map((row) => row.trackIndex),
    [0, 1, 2]
  )
})

test('buildTrackListRows can be disabled', () => {
  const rows = buildTrackListRows([
    track(1),
    track(2)
  ], false)

  assert.deepEqual(summarizeRows(rows), [
    'track:0',
    'track:1'
  ])
})
