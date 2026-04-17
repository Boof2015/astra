import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LYRICS_POPOUT_WINDOW_DEFAULT_HEIGHT,
  LYRICS_POPOUT_WINDOW_DEFAULT_WIDTH,
  LYRICS_POPOUT_WINDOW_MIN_HEIGHT,
  LYRICS_POPOUT_WINDOW_MIN_WIDTH,
  normalizeLyricsPopoutWindowPrefs,
  type LyricsPopoutWorkArea
} from './lyricsPopout.ts'

const DISPLAY_WORK_AREAS: LyricsPopoutWorkArea[] = [
  { x: 0, y: 0, width: 1440, height: 900 },
  { x: 1440, y: 0, width: 1920, height: 1080 },
]

test('normalizeLyricsPopoutWindowPrefs clamps width and height into supported bounds', () => {
  const normalized = normalizeLyricsPopoutWindowPrefs({
    width: 120,
    height: 9_999
  }, DISPLAY_WORK_AREAS)

  assert.equal(normalized.width, LYRICS_POPOUT_WINDOW_MIN_WIDTH)
  assert.equal(normalized.height, 1400)
})

test('normalizeLyricsPopoutWindowPrefs drops invalid positions that are off-screen', () => {
  const normalized = normalizeLyricsPopoutWindowPrefs({
    x: -5_000,
    y: -5_000,
    width: 540,
    height: 420
  }, DISPLAY_WORK_AREAS)

  assert.deepEqual(normalized, {
    width: 540,
    height: 420
  })
})

test('normalizeLyricsPopoutWindowPrefs preserves valid on-screen bounds', () => {
  const normalized = normalizeLyricsPopoutWindowPrefs({
    x: 1520.2,
    y: 80.8,
    width: 640.7,
    height: 360.2
  }, DISPLAY_WORK_AREAS)

  assert.deepEqual(normalized, {
    x: 1520,
    y: 81,
    width: 641,
    height: 360
  })
})

test('normalizeLyricsPopoutWindowPrefs falls back to defaults for invalid input', () => {
  const normalized = normalizeLyricsPopoutWindowPrefs('invalid', DISPLAY_WORK_AREAS)

  assert.deepEqual(normalized, {
    width: LYRICS_POPOUT_WINDOW_DEFAULT_WIDTH,
    height: LYRICS_POPOUT_WINDOW_DEFAULT_HEIGHT
  })
})

test('normalizeLyricsPopoutWindowPrefs ignores position validation when no displays are provided', () => {
  const normalized = normalizeLyricsPopoutWindowPrefs({
    x: 120,
    y: 84,
    width: 500,
    height: 260
  })

  assert.deepEqual(normalized, {
    x: 120,
    y: 84,
    width: 500,
    height: Math.max(LYRICS_POPOUT_WINDOW_MIN_HEIGHT, 260)
  })
})
