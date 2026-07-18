import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeStatsShareFileName,
  STATS_SHARE_PNG_HEIGHT,
  STATS_SHARE_PNG_WIDTH,
  validateStatsSharePng
} from './statsShareImage'

function createPngHeader(width = STATS_SHARE_PNG_WIDTH, height = STATS_SHARE_PNG_HEIGHT): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([73, 72, 68, 82], 12)
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)
  return bytes
}

test('share-card PNG validation accepts only the fixed export dimensions', () => {
  const bytes = createPngHeader()
  assert.equal(validateStatsSharePng(bytes), bytes)
  assert.throws(() => validateStatsSharePng(createPngHeader(1080, 1350)), /1474×1920/)
  assert.throws(() => validateStatsSharePng(new Uint8Array(33)), /not a PNG/)
  assert.throws(() => validateStatsSharePng('not bytes'), /Invalid share-card PNG data/)
})

test('share-card filename normalization strips paths, unsafe characters, and non-PNG extensions', () => {
  assert.equal(normalizeStatsShareFileName('astra-listening-30d-2026-07-18.png'), 'astra-listening-30d-2026-07-18.png')
  assert.equal(normalizeStatsShareFileName('../../My Listening / July.jpg'), 'July.png')
  assert.equal(normalizeStatsShareFileName(' Listening: July! '), 'Listening-July.png')
  assert.equal(normalizeStatsShareFileName('', new Date('2026-07-18T12:00:00Z').getTime()), 'astra-listening-2026-07-18.png')
})
