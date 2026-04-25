import assert from 'node:assert/strict'
import test from 'node:test'
import { findActiveSyncedLineIndex, getLyricsSourceLabel } from './lyricsPresentation.ts'

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

test('getLyricsSourceLabel labels local LRC files', () => {
  assert.equal(getLyricsSourceLabel('lrc'), 'LRC File')
})
