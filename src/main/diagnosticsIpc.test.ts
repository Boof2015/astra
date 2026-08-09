import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeLocalPcmOutputSink,
  normalizeMemoryDiagnosticsLogEventOptions,
  resolveLegacyLocalPcmTempFileSinkChange
} from './diagnosticsIpc'

test('normalizes only supported PCM output routes', () => {
  assert.equal(normalizeLocalPcmOutputSink('stdout_pipe'), 'stdout_pipe')
  assert.equal(normalizeLocalPcmOutputSink('rechunked_pipe'), 'rechunked_pipe')
  assert.equal(normalizeLocalPcmOutputSink('native_pipe'), 'native_pipe')
  assert.equal(normalizeLocalPcmOutputSink('worker_thread'), 'worker_thread')
  assert.equal(normalizeLocalPcmOutputSink('temporary_file'), 'temporary_file')
  for (const invalid of [undefined, null, false, 0, '', 'worker', 'WORKER_THREAD', [], {}]) {
    assert.equal(normalizeLocalPcmOutputSink(invalid), null)
  }
})

test('legacy temporary-file changes do not disable a selected worker route', () => {
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('stdout_pipe', true), 'temporary_file')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('rechunked_pipe', true), 'temporary_file')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('native_pipe', true), 'temporary_file')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('worker_thread', true), 'temporary_file')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('temporary_file', false), 'stdout_pipe')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('rechunked_pipe', false), 'rechunked_pipe')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('native_pipe', false), 'native_pipe')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('worker_thread', false), 'worker_thread')
  assert.equal(resolveLegacyLocalPcmTempFileSinkChange('stdout_pipe', false), 'stdout_pipe')
})

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
