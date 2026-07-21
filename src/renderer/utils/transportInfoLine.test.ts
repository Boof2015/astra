import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTransportInfoLine } from './transportInfoLine.ts'

test('output mode preserves the current output-device line', () => {
  assert.deepEqual(resolveTransportInfoLine('output', 'Desk DAC', 'Album'), {
    prefix: 'OUT',
    value: 'Desk DAC',
    title: 'Desk DAC',
    action: null
  })
})

test('album mode creates an actionable album line', () => {
  assert.deepEqual(resolveTransportInfoLine('album', 'Desk DAC', '  Blue Train  '), {
    prefix: 'ALB',
    value: 'Blue Train',
    title: 'Show album Blue Train',
    action: 'open-album'
  })
})

test('album mode uses a non-actionable placeholder when album metadata is missing', () => {
  assert.deepEqual(resolveTransportInfoLine('album', 'Desk DAC', '   '), {
    prefix: 'ALB',
    value: '\u2014',
    title: 'Album unavailable',
    action: null
  })
  assert.equal(resolveTransportInfoLine('album', 'Desk DAC', null)?.action, null)
})

test('hidden mode omits the primary transport info line', () => {
  assert.equal(resolveTransportInfoLine('hidden', 'Desk DAC', 'Album'), null)
})
