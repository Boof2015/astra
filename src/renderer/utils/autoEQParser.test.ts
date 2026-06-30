import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAutoEQ } from './autoEQParser.ts'
import { EQ_MAX_BANDS } from './eq.ts'

test('AutoEQ parsing preserves the first maximum supported enabled filters', () => {
  const lines = [
    'Preamp: -3.5 dB',
    ...Array.from({ length: EQ_MAX_BANDS + 4 }, (_, index) => (
      `Filter ${index + 1}: ON PK Fc ${100 + index} Hz Gain ${index % 5 - 2} dB Q 1.${index % 10}`
    )),
  ]

  const preset = parseAutoEQ(lines.join('\n'), 'rew-export.txt')

  assert.equal(preset.name, 'rew-export')
  assert.equal(preset.preamp, -3.5)
  assert.equal(preset.bands.length, EQ_MAX_BANDS)
  assert.equal(preset.bands[0].frequency, 100)
  assert.equal(preset.bands.at(-1)?.frequency, 100 + EQ_MAX_BANDS - 1)
})
