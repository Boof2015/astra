import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDiscordActivityDetails } from './discordRpcActivity.ts'

test('pads one-character titles with a zero-width space', () => {
  assert.equal(normalizeDiscordActivityDetails('X', 128), 'X\u200B')
})

test('trims one-character titles before padding them', () => {
  assert.equal(normalizeDiscordActivityDetails(' X ', 128), 'X\u200B')
})

test('keeps titles with at least two characters unchanged', () => {
  assert.equal(normalizeDiscordActivityDetails('AB', 128), 'AB')
})

test('returns null for blank titles', () => {
  assert.equal(normalizeDiscordActivityDetails('', 128), null)
  assert.equal(normalizeDiscordActivityDetails('   ', 128), null)
})

test("truncates long titles to Discord's max length after normalization", () => {
  const longTitle = 'A'.repeat(129)
  const normalized = normalizeDiscordActivityDetails(longTitle, 128)

  assert.equal(normalized, `${'A'.repeat(127)}\u2026`)
  assert.equal(normalized?.length, 128)
})
