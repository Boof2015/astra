import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMemoryDiagnosticsLogEventOptions } from './diagnosticsIpc'

test('normalizes the optional captureSample flag without coercion', () => {
  assert.deepEqual(normalizeMemoryDiagnosticsLogEventOptions(undefined), {})
  assert.deepEqual(normalizeMemoryDiagnosticsLogEventOptions({}), {})
  assert.deepEqual(normalizeMemoryDiagnosticsLogEventOptions({ captureSample: true }), { captureSample: true })
  assert.deepEqual(normalizeMemoryDiagnosticsLogEventOptions({ captureSample: false }), { captureSample: false })
})

test('rejects malformed diagnostics log-event options', () => {
  for (const invalid of [null, false, 0, 'false', [], { captureSample: 0 }, { captureSample: 'false' }]) {
    assert.equal(normalizeMemoryDiagnosticsLogEventOptions(invalid), null)
  }
})
