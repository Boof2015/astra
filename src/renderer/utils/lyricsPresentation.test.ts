import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findActiveSyncedLineIndex,
  getCompactSyncedLyricsLineHeights,
  getLyricsLineSeekTimeSeconds,
  getPreferredLyricsTranslation,
  getLyricsSourceLabel,
  getRenderableSyncedLines,
  getSyncedLyricsGapProgress,
  getSyncedLyricsDisplayLines,
  resolveLyricsWordTiming,
  resolveSyncedLyricsTiming
} from './lyricsPresentation.ts'

const defaultLyricsLayerSettings = {
  wordTimingEnabled: true,
  furiganaEnabled: true,
  translationsEnabled: true,
  translationLanguagePriority: ['en', 'ja-Latn'],
  voiceLabelsEnabled: false
}

const lines = [
  { timestampMs: 1_000, text: 'line 1' },
  { timestampMs: 2_500, text: 'line 2' },
  { timestampMs: 4_000, text: 'line 3' },
]

test('getLyricsLineSeekTimeSeconds converts lyric timestamps to seek seconds', () => {
  assert.equal(getLyricsLineSeekTimeSeconds(42_500, 180, 0), 42.5)
})

test('getLyricsLineSeekTimeSeconds adds output delay compensation', () => {
  assert.equal(getLyricsLineSeekTimeSeconds(42_500, 180, 250), 42.75)
})

test('getLyricsLineSeekTimeSeconds clamps to known track duration', () => {
  assert.equal(getLyricsLineSeekTimeSeconds(179_900, 180, 250), 180)
})

test('getLyricsLineSeekTimeSeconds rejects invalid lyric timestamps', () => {
  assert.equal(getLyricsLineSeekTimeSeconds(Number.NaN, 180, 0), null)
  assert.equal(getLyricsLineSeekTimeSeconds(-1, 180, 0), null)
})

test('getLyricsLineSeekTimeSeconds ignores invalid or negative delay compensation', () => {
  assert.equal(getLyricsLineSeekTimeSeconds(42_500, 180, Number.NaN), 42.5)
  assert.equal(getLyricsLineSeekTimeSeconds(42_500, 180, -250), 42.5)
})

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
    { timestampMs: 12_000, text: 'line 2' },
  ]

  assert.equal(findActiveSyncedLineIndex(gapLines, 4.9), 0)
  assert.equal(findActiveSyncedLineIndex(gapLines, 5.1), -1)
  assert.equal(findActiveSyncedLineIndex(gapLines, 12), 2)
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

  assert.equal(findActiveSyncedLineIndex(outroLines, 13.9, { durationSeconds: 21 }), 1)
  assert.equal(findActiveSyncedLineIndex(outroLines, 14.1, { durationSeconds: 21 }), -1)
})

test('resolveSyncedLyricsTiming keeps a focus line during neutral gaps', () => {
  const gapLines = [
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 12_000, text: 'line 2' },
  ]

  assert.deepEqual(resolveSyncedLyricsTiming(gapLines, 5.1), {
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
    { timestampMs: 12_000, text: 'line 2' },
    { timestampMs: 14_000, text: '', kind: 'silence' },
    { timestampMs: 16_000, text: 'line 3' },
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
      timestampMs: 5_000,
      text: '',
      progressStartMs: 1_000,
      progressEndMs: 12_000
    },
    {
      kind: 'lyric',
      line: { timestampMs: 12_000, text: 'line 2' },
      cueIndex: 1,
      afterCueIndex: null,
      displayIndex: 2,
      key: 'lyric:12000:1',
      timestampMs: 12_000,
      text: 'line 2'
    },
    {
      kind: 'gap',
      cueIndex: 2,
      afterCueIndex: null,
      displayIndex: 3,
      key: 'gap-cue:14000:2',
      timestampMs: 14_000,
      text: '',
      progressStartMs: 14_000,
      progressEndMs: 16_000
    },
    {
      kind: 'lyric',
      line: { timestampMs: 16_000, text: 'line 3' },
      cueIndex: 3,
      afterCueIndex: null,
      displayIndex: 4,
      key: 'lyric:16000:3',
      timestampMs: 16_000,
      text: 'line 3'
    },
  ])
})

test('getSyncedLyricsGapProgress resolves calm progress through a gap row', () => {
  const displayLines = getSyncedLyricsDisplayLines([
    { timestampMs: 1_000, text: 'line 1' },
    { timestampMs: 12_000, text: 'line 2' },
  ])
  const gapLine = displayLines[1]

  assert.equal(getSyncedLyricsGapProgress(gapLine, 1), 0)
  assert.equal(getSyncedLyricsGapProgress(gapLine, 6.5), 0.5)
  assert.equal(getSyncedLyricsGapProgress(gapLine, 12), 1)
})

test('getLyricsSourceLabel labels local LRC files', () => {
  assert.equal(getLyricsSourceLabel('lrc'), 'LRC File')
})

test('getLyricsSourceLabel labels XLRC and manual XLRC sources', () => {
  assert.equal(getLyricsSourceLabel('xlrc', 'xlrc'), 'XLRC File')
  assert.equal(getLyricsSourceLabel('manual', 'xlrc'), 'Manual XLRC')
  assert.equal(getLyricsSourceLabel('manual', 'lrc'), 'Manual')
})

test('getPreferredLyricsTranslation follows language priority with fallback', () => {
  const line = {
    timestampMs: 1_000,
    text: 'line',
    translations: [
      { lang: 'ja-Latn', text: 'romaji' },
      { lang: 'en', text: 'English' }
    ]
  }

  assert.deepEqual(getPreferredLyricsTranslation(line, ['en', 'ja-Latn']), { lang: 'en', text: 'English' })
  assert.deepEqual(getPreferredLyricsTranslation(line, ['ko']), { lang: 'ja-Latn', text: 'romaji' })
})

test('getCompactSyncedLyricsLineHeights grows only affected rich rows', () => {
  const displayLines = getSyncedLyricsDisplayLines([
    {
      timestampMs: 500,
      text: 'plain'
    },
    {
      timestampMs: 750,
      text: 'voice only',
      voice: 'Lead'
    },
    {
      timestampMs: 1_000,
      text: '顔',
      furigana: [{ start: 0, end: 1, base: '顔', reading: 'kao' }],
      translations: [{ lang: 'en', text: 'face' }]
    }
  ])

  assert.deepEqual(getCompactSyncedLyricsLineHeights(displayLines, {
    ...defaultLyricsLayerSettings,
    voiceLabelsEnabled: true
  }), [34, 34, 62])
  assert.deepEqual(getCompactSyncedLyricsLineHeights(displayLines, {
    ...defaultLyricsLayerSettings,
    furiganaEnabled: false,
    translationsEnabled: false
  }), [34, 34, 34])
})

test('resolveLyricsWordTiming resolves active word and progress', () => {
  assert.deepEqual(resolveLyricsWordTiming([
    { timestampMs: 1_000, text: 'one' },
    { timestampMs: 2_000, text: 'two' },
    { timestampMs: 3_000, text: 'three' }
  ], 2.5), {
    activeWordIndex: 1,
    progressByIndex: [1, 0.5, 0]
  })
})
