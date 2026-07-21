import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeSignalShareFileName,
  SIGNAL_SHARE_PNG_HEIGHT,
  SIGNAL_SHARE_PNG_WIDTHS,
  validateSignalSharePng
} from './signalShareImage'

function createPngHeader(width: number = SIGNAL_SHARE_PNG_WIDTHS[0], height = SIGNAL_SHARE_PNG_HEIGHT): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([73, 72, 68, 82], 12)
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)
  return bytes
}

test('Signal PNG validation accepts only canonical branded dimensions', () => {
  for (const width of SIGNAL_SHARE_PNG_WIDTHS) {
    const bytes = createPngHeader(width)
    assert.equal(validateSignalSharePng(bytes), bytes)
  }
  assert.throws(() => validateSignalSharePng(createPngHeader(1080)), /unexpected dimensions/)
  assert.throws(() => validateSignalSharePng(createPngHeader(1188, 361)), /unexpected dimensions/)
  assert.throws(() => validateSignalSharePng(new Uint8Array(33)), /not a PNG/)
  assert.throws(() => validateSignalSharePng('not bytes'), /Invalid Signal PNG data/)
})

test('Signal filenames strip paths, unsafe characters, and non-PNG extensions', () => {
  assert.equal(
    normalizeSignalShareFileName('astra-signal-N!GHT-#iwannadance.png'),
    'astra-signal-N-GHT-iwannadance.png'
  )
  assert.equal(normalizeSignalShareFileName('../../Astra / Replay.jpg'), 'Replay.png')
  assert.equal(normalizeSignalShareFileName(' Café: Replay! '), 'Cafe-Replay.png')
  assert.equal(normalizeSignalShareFileName(''), 'astra-signal.png')
})
