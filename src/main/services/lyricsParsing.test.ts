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

test('parseLrcSyncedLines applies offset and clamps shifted timestamps', () => {
  assert.deepEqual(
    parseLrcSyncedLines('[offset:+250]\n[00:01.00]Later\n[00:02.50]Second'),
    [
      { timestampMs: 1_250, text: 'Later' },
      { timestampMs: 2_750, text: 'Second' }
    ]
  )

  assert.deepEqual(
    parseLrcSyncedLines('[offset:-1500]\n[00:01.00]Clamped'),
    [
      { timestampMs: 0, text: 'Clamped' }
    ]
  )
})

test('parseLrcSyncedLines preserves Enhanced LRC word timing', () => {
  assert.deepEqual(
    parseLrcSyncedLines('[00:10.00]<00:10.00>Hello <00:10.30>world'),
    [
      {
        timestampMs: 10_000,
        text: 'Hello world',
        words: [
          { timestampMs: 10_000, text: 'Hello ' },
          { timestampMs: 10_300, text: 'world' }
        ]
      }
    ]
  )
})

test('parseLyricsText keeps Enhanced LRC word timing in an LRC payload', () => {
  const payload = parseLyricsText('[00:10.00]<00:10.00>Hello <00:10.30>world', 'lrc', 'lrc')

  assert.ok(payload)
  assert.equal(payload.format, 'lrc')
  assert.deepEqual(payload.syncedLines, [
    {
      timestampMs: 10_000,
      text: 'Hello world',
      words: [
        { timestampMs: 10_000, text: 'Hello ' },
        { timestampMs: 10_300, text: 'world' }
      ]
    }
  ])
})

test('parseLrcSyncedLines applies offsets to Enhanced LRC word timing', () => {
  assert.deepEqual(
    parseLrcSyncedLines(
      '[offset:+250]\n[00:10.00]<00:10.00>Hello <00:10.30>world'
    ),
    [
      {
        timestampMs: 10_250,
        text: 'Hello world',
        words: [
          { timestampMs: 10_250, text: 'Hello ' },
          { timestampMs: 10_550, text: 'world' }
        ]
      }
    ]
  )
})

test('parseLrcSyncedLines falls back to complete line text for partial word timing', () => {
  assert.deepEqual(
    parseLrcSyncedLines('[00:10.00]Hello <00:10.30>world'),
    [
      { timestampMs: 10_000, text: 'Hello world' }
    ]
  )
})

test('parseLrcSyncedLines keeps XLRC-only fields out of LRC payloads', () => {
  const payload = parseLyricsText(
    [
      '[00:10.00]<00:10.00>私[わたし]',
      '[>en]Me',
      '[00:12.00][v:A]Next'
    ].join('\n'),
    'lrc',
    'lrc'
  )

  assert.ok(payload)
  assert.equal(payload.format, 'lrc')
  assert.deepEqual(payload.syncedLines, [
    {
      timestampMs: 10_000,
      text: '私',
      words: [{ timestampMs: 10_000, text: '私' }]
    },
    { timestampMs: 12_000, text: 'Next' }
  ])
})

test('parseLrcSyncedLines preserves repeated timestamps on one row', () => {
  assert.deepEqual(
    parseLrcSyncedLines('[00:10.00][00:42.00]Chorus'),
    [
      { timestampMs: 10_000, text: 'Chorus' },
      { timestampMs: 42_000, text: 'Chorus' }
    ]
  )
})

test('parseLyricsText maps XLRC rich data while preserving silence cues', () => {
  const payload = parseLyricsText(
    [
      '[lang:ja]',
      '[langs:ja,en,ja-Latn]',
      '[offset:+100]',
      '',
      '[00:00.00]',
      '[00:12.40]<00:12.40>私[わたし]<00:12.90>が<00:13.10>歌[うた]う',
      '[>en]I sing',
      '[>ja-Latn]watashi ga utau',
      '[00:15.20][v:A]君は',
      '[>en]You are'
    ].join('\n'),
    'xlrc',
    'xlrc'
  )

  assert.ok(payload)
  assert.equal(payload.source, 'xlrc')
  assert.equal(payload.format, 'xlrc')
  assert.equal(payload.plainLyrics, '私が歌う\n君は')
  assert.deepEqual(payload.syncedLines, [
    { timestampMs: 100, text: '', kind: 'silence' },
    {
      timestampMs: 12_500,
      text: '私が歌う',
      words: [
        {
          timestampMs: 12_500,
          text: '私',
          furigana: [{ start: 0, end: 1, base: '私', reading: 'わたし' }]
        },
        { timestampMs: 13_000, text: 'が' },
        {
          timestampMs: 13_200,
          text: '歌う',
          furigana: [{ start: 0, end: 1, base: '歌', reading: 'うた' }]
        }
      ],
      furigana: [
        { start: 0, end: 1, base: '私', reading: 'わたし' },
        { start: 2, end: 3, base: '歌', reading: 'うた' }
      ],
      translations: [
        { lang: 'en', text: 'I sing' },
        { lang: 'ja-Latn', text: 'watashi ga utau' }
      ]
    },
    {
      timestampMs: 15_300,
      text: '君は',
      translations: [{ lang: 'en', text: 'You are' }],
      voice: 'A'
    }
  ])
})
