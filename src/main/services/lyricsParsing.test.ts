import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseLyricsText,
  parseLrcSyncedLines,
  toPlainLyricsFromLines
} from './lyricsParsing.ts'

test('parseLrcSyncedLines preserves timed blank rows as silence cues', () => {
  assert.deepEqual(
    parseLrcSyncedLines('[00:01.00]First line\n[00:03.50]\n[00:05.00]Second line'),
    [
      { timestampMs: 1_000, text: 'First line' },
      { timestampMs: 3_500, text: '', kind: 'silence' },
      { timestampMs: 5_000, text: 'Second line' }
    ]
  )
})

test('toPlainLyricsFromLines excludes silence cues', () => {
  assert.equal(toPlainLyricsFromLines([
    { timestampMs: 1_000, text: 'First line' },
    { timestampMs: 3_500, text: '', kind: 'silence' },
    { timestampMs: 5_000, text: 'Second line' }
  ]), 'First line\nSecond line')
})

test('parseLyricsText keeps silence cues out of plain lyrics', () => {
  const payload = parseLyricsText(
    '[00:01.00]First line\n[00:03.50]\n[00:05.00]Second line',
    'manual'
  )

  assert.ok(payload)
  assert.equal(payload.plainLyrics, 'First line\nSecond line')
  assert.deepEqual(payload.syncedLines, [
    { timestampMs: 1_000, text: 'First line' },
    { timestampMs: 3_500, text: '', kind: 'silence' },
    { timestampMs: 5_000, text: 'Second line' }
  ])
})
