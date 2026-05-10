import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findActiveSyncedLineIndex,
  getLyricsSourceLabel,
  getRenderableSyncedLines,
  getSyncedLyricsGapProgress,
  getSyncedLyricsDisplayLines,
  resolveSyncedLyricsTiming
} from './lyricsPresentation.ts'

const lines = [
  { timestampMs: 1_000, text: 'line 1' },
  { timestampMs: 2_500, text: 'line 2' },
  { timestampMs: 4_000, text: 'line 3' },
]

test('findActiveSyncedLineIndex returns -1 before the first synced line', () => {
  assert.equal(findActiveSyncedLineIndex(lines, 0.5), -1)
})

test('findActiveSyncedLineIndex matches an exact synced line timestamp', () => {
  assert.equal(findActiveSyncedLineIndex(lines, 2.5), 1)
})

test('findActiveSyncedLineIndex returns the latest line before the current time', () => {
  assert.equal(findActiveSyncedLineIndex(lines, 3.2), 1)
})

test('findActiveSyncedLineIndex returns the final line after the last timestamp', () => {
  assert.equal(findActiveSyncedLineIndex(lines, 9), 2)
})

test('findActiveSyncedLineIndex holds through short gaps', () => {
  assert.equal(findActiveSyncedLineIndex([
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 5_000, text: 'line 2' },
  ], 4.2), 0)
})

test('findActiveSyncedLineIndex goes neutral during long gaps after the hold window', () => {
  const gapLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 8_000, text: 'line 2' },
  ]

  assert.equal(findActiveSyncedLineIndex(gapLines, 3.4), 0)
  assert.equal(findActiveSyncedLineIndex(gapLines, 3.6), -1)
  assert.equal(findActiveSyncedLineIndex(gapLines, 8), 2)
})

test('findActiveSyncedLineIndex respects explicit silence cues', () => {
  const gapLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 3_000, text: '', kind: 'silence' as const },
    { timestampMs: 5_000, text: 'line 2' },
  ]

  assert.equal(findActiveSyncedLineIndex(gapLines, 2.9), 0)
  assert.equal(findActiveSyncedLineIndex(gapLines, 3), -1)
  assert.equal(findActiveSyncedLineIndex(gapLines, 5), 2)
})

test('findActiveSyncedLineIndex goes neutral during a long final outro when duration is known', () => {
  const outroLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 10_000, text: 'last line' },
  ]

  assert.equal(findActiveSyncedLineIndex(outroLines, 12.4, { durationSeconds: 20 }), 2)
  assert.equal(findActiveSyncedLineIndex(outroLines, 12.6, { durationSeconds: 20 }), -1)
})

test('resolveSyncedLyricsTiming keeps a focus line during neutral gaps', () => {
  const gapLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 8_000, text: 'line 2' },
  ]

  assert.deepEqual(resolveSyncedLyricsTiming(gapLines, 3.6), {
    activeCueIndex: 0,
    activeLineIndex: -1,
    focusLineIndex: 1,
    isNeutral: true
  })
})

test('resolveSyncedLyricsTiming focuses explicit silence cue rows', () => {
  const gapLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 3_000, text: '', kind: 'silence' as const },
    { timestampMs: 5_000, text: 'line 2' },
  ]

  assert.deepEqual(resolveSyncedLyricsTiming(gapLines, 3), {
    activeCueIndex: 1,
    activeLineIndex: -1,
    focusLineIndex: 1,
    isNeutral: true
  })
})

test('getRenderableSyncedLines excludes silence cues while preserving cue indices', () => {
  assert.deepEqual(getRenderableSyncedLines([
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 3_000, text: '', kind: 'silence' },
    { timestampMs: 5_000, text: 'line 2' },
  ]), [
    { line: { timestampMs: 1_000, text: 'line 1' }, cueIndex: 0, displayIndex: 0 },
    { line: { timestampMs: 5_000, text: 'line 2' }, cueIndex: 2, displayIndex: 1 },
  ])
})

test('getSyncedLyricsDisplayLines inserts gap rows for silence and inferred long gaps', () => {
  assert.deepEqual(getSyncedLyricsDisplayLines([
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 8_000, text: 'line 2' },
    { timestampMs: 10_000, text: '', kind: 'silence' },
    { timestampMs: 12_000, text: 'line 3' },
  ]), [
    {
      kind: 'lyric',
      line: { timestampMs: 1_000, text: 'line 1' },
      cueIndex: 0,
      afterCueIndex: null,
      displayIndex: 0,
      key: 'lyric:1000:0',
      timestampMs: 1_000,
      text: 'line 1'
    },
    {
      kind: 'gap',
      cueIndex: null,
      afterCueIndex: 0,
      displayIndex: 1,
      key: 'gap-after:1000:0',
      timestampMs: 3_500,
      text: '',
      progressStartMs: 1_000,
      progressEndMs: 8_000
    },
    {
      kind: 'lyric',
      line: { timestampMs: 8_000, text: 'line 2' },
      cueIndex: 1,
      afterCueIndex: null,
      displayIndex: 2,
      key: 'lyric:8000:1',
      timestampMs: 8_000,
      text: 'line 2'
    },
    {
      kind: 'gap',
      cueIndex: 2,
      afterCueIndex: null,
      displayIndex: 3,
      key: 'gap-cue:10000:2',
      timestampMs: 10_000,
      text: '',
      progressStartMs: 10_000,
      progressEndMs: 12_000
    },
    {
      kind: 'lyric',
      line: { timestampMs: 12_000, text: 'line 3' },
      cueIndex: 3,
      afterCueIndex: null,
      displayIndex: 4,
      key: 'lyric:12000:3',
      timestampMs: 12_000,
      text: 'line 3'
    },
  ])
})

test('getSyncedLyricsGapProgress resolves calm progress through a gap row', () => {
  const displayLines = getSyncedLyricsDisplayLines([
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 8_000, text: 'line 2' },
  ])
  const gapLine = displayLines[1]

  assert.equal(getSyncedLyricsGapProgress(gapLine, 1), 0)
  assert.equal(getSyncedLyricsGapProgress(gapLine, 4.5), 0.5)
  assert.equal(getSyncedLyricsGapProgress(gapLine, 8), 1)
})

test('getLyricsSourceLabel labels local LRC files', () => {
  assert.equal(getLyricsSourceLabel('lrc'), 'LRC File')
})
