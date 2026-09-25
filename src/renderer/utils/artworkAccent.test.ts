import assert from 'node:assert/strict'
import test from 'node:test'
import { contrastRatio, ensureReadableOnDark } from './artworkAccent'

const BACKGROUND = '#0c0c0e'

test('deep accents are lifted until they read on a dark background', () => {
  assert.ok(contrastRatio('#1a1aff', BACKGROUND) < 4.5)
  const lifted = ensureReadableOnDark('#1a1aff', BACKGROUND)
  assert.ok(contrastRatio(lifted, BACKGROUND) >= 4.5)
  assert.notEqual(lifted, '#ffffff')
})

test('already-readable accents and non-hex values pass through unchanged', () => {
  assert.equal(ensureReadableOnDark('#38bdf8', BACKGROUND), '#38bdf8')
  assert.equal(ensureReadableOnDark('rgb(1, 2, 3)', BACKGROUND), 'rgb(1, 2, 3)')
})
