import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PCM_TRANSFER_BENCHMARK_MAX_BYTES,
  PCM_TRANSFER_BENCHMARK_STREAM_VERSION,
  createPcmTransferBenchmarkProbe,
  fillPcmTransferBenchmarkChunk,
  normalizePcmTransferBenchmarkSize,
  validatePcmTransferBenchmarkStreamOpenRequest,
  validatePcmTransferBenchmarkProbe
} from './pcmTransferBenchmark'

test('normalizes only positive integer benchmark sizes through 72 MiB', () => {
  assert.equal(normalizePcmTransferBenchmarkSize(1), 1)
  assert.equal(normalizePcmTransferBenchmarkSize(PCM_TRANSFER_BENCHMARK_MAX_BYTES), PCM_TRANSFER_BENCHMARK_MAX_BYTES)

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, PCM_TRANSFER_BENCHMARK_MAX_BYTES + 1]) {
    assert.throws(() => normalizePcmTransferBenchmarkSize(invalid), RangeError)
  }
})

test('creates a timed sentinel-marked payload and validates its transfer contract', () => {
  const clockSamples = [10, 11.234, 20, 24.567]
  const probe = createPcmTransferBenchmarkProbe(1024, () => clockSamples.shift() ?? 0)

  assert.equal(probe.allocationMs, 1.23)
  assert.equal(probe.fillMs, 4.57)
  assert.equal(validatePcmTransferBenchmarkProbe(probe, 1024), true)
})

test('rejects mismatched lengths and corrupted sentinels', () => {
  const wrongLength = createPcmTransferBenchmarkProbe(1024)
  wrongLength.byteLength = 512
  assert.equal(validatePcmTransferBenchmarkProbe(wrongLength, 1024), false)

  const corrupt = createPcmTransferBenchmarkProbe(1024)
  new Uint8Array(corrupt.payload)[Math.floor(corrupt.sizeBytes / 2)] = 0
  assert.equal(validatePcmTransferBenchmarkProbe(corrupt, 1024), false)
})

test('validates colliding sentinel offsets for the smallest bounded payload', () => {
  const probe = createPcmTransferBenchmarkProbe(1)
  assert.equal(validatePcmTransferBenchmarkProbe(probe, 1), true)
})

test('validates bounded Float32-aligned port benchmark requests', () => {
  const valid = {
    version: PCM_TRANSFER_BENCHMARK_STREAM_VERSION,
    requestId: 3,
    sizeBytes: PCM_TRANSFER_BENCHMARK_MAX_BYTES,
    nonce: 'benchmark_3'
  }
  assert.equal(validatePcmTransferBenchmarkStreamOpenRequest(valid), true)

  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, requestId: -1 },
    { ...valid, sizeBytes: 1 },
    { ...valid, sizeBytes: PCM_TRANSFER_BENCHMARK_MAX_BYTES + 4 },
    { ...valid, nonce: 'invalid nonce' }
  ]) {
    assert.equal(validatePcmTransferBenchmarkStreamOpenRequest(invalid), false)
  }
})

test('fills independent bounded chunks with full-payload sentinel positions', () => {
  const sizeBytes = (8 * 1024 * 1024) + 16
  const first = new Uint8Array(8 * 1024 * 1024)
  const last = new Uint8Array(16)
  fillPcmTransferBenchmarkChunk(first, 0, sizeBytes)
  fillPcmTransferBenchmarkChunk(last, first.byteLength, sizeBytes)

  assert.equal(first[0], 0xa5)
  assert.equal(first[Math.floor(sizeBytes / 2)], 0x5a)
  assert.equal(first[1024], 0x6d)
  assert.equal(last.at(-1), 0xc3)
  assert.throws(
    () => fillPcmTransferBenchmarkChunk(last, sizeBytes, sizeBytes),
    RangeError
  )
})
