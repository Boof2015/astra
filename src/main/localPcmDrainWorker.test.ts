import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LocalPcmBoundedStderr,
  LocalPcmOwnedBatcher
} from './localPcmDrainWorker.ts'

test('aggregates arbitrary fragments into exact owned batches in order', () => {
  const batcher = new LocalPcmOwnedBatcher(8, 24)
  const source = Uint8Array.from({ length: 19 }, (_, index) => index + 1)
  const batches: Array<{ offset: number; bytes: number[] }> = []
  let sourceOffset = 0
  while (sourceOffset < source.byteLength) {
    sourceOffset += batcher.append(source.subarray(sourceOffset))
    const batch = batcher.takeBatch()
    if (batch) {
      batches.push({
        offset: batch.byteOffset,
        bytes: Array.from(new Uint8Array(batch.payload))
      })
    }
  }
  const finalBatch = batcher.takeBatch({ allowPartial: true })
  assert.ok(finalBatch)
  batches.push({
    offset: finalBatch.byteOffset,
    bytes: Array.from(new Uint8Array(finalBatch.payload))
  })

  assert.deepEqual(batches, [
    { offset: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] },
    { offset: 8, bytes: [9, 10, 11, 12, 13, 14, 15, 16] },
    { offset: 16, bytes: [17, 18, 19] }
  ])
  assert.equal(batcher.totalByteLength, 19)
  assert.equal(batcher.emittedByteLength, 19)
})

test('transferable batches own exact ArrayBuffers', () => {
  const batcher = new LocalPcmOwnedBatcher(8, 16)
  batcher.append(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
  const batch = batcher.takeBatch()
  assert.ok(batch)
  assert.equal(batch.payload.byteLength, 8)
  const cloned = structuredClone(batch.payload, { transfer: [batch.payload] })
  assert.equal(batch.payload.byteLength, 0)
  assert.deepEqual(Array.from(new Uint8Array(cloned)), [1, 2, 3, 4, 5, 6, 7, 8])

  batcher.append(Uint8Array.from([9, 10, 11]))
  const partial = batcher.takeBatch({ allowPartial: true })
  assert.ok(partial)
  assert.equal(partial.payload.byteLength, 3)
  assert.deepEqual(Array.from(new Uint8Array(partial.payload)), [9, 10, 11])
})

test('enforces the byte cap before partially accepting an oversized fragment', () => {
  const batcher = new LocalPcmOwnedBatcher(4, 8)
  assert.equal(batcher.append(Uint8Array.from([1, 2, 3, 4])), 4)
  assert.ok(batcher.takeBatch())
  assert.throws(
    () => batcher.append(Uint8Array.from([5, 6, 7, 8, 9])),
    /192 MiB Standard playback limit/
  )
  assert.equal(batcher.totalByteLength, 4)
})

test('retains only the bounded stderr tail, including split UTF-8 input', () => {
  const stderr = new LocalPcmBoundedStderr(8)
  stderr.append('abcdefgh')
  stderr.append('ijkl')
  assert.equal(stderr.toString(), 'efghijkl')
  assert.ok(Buffer.byteLength(stderr.toString(), 'utf8') <= 8)

  const unicode = new LocalPcmBoundedStderr(4)
  unicode.append(Buffer.from([0x80, 0x80, 0x61, 0x62]))
  assert.ok(Buffer.byteLength(unicode.toString(), 'utf8') <= 4)
})

test('rejects invalid batch, cap, and stderr sizes', () => {
  assert.throws(() => new LocalPcmOwnedBatcher(0, 8), /batch size/)
  assert.throws(() => new LocalPcmOwnedBatcher(8, 7), /byte cap/)
  assert.throws(() => new LocalPcmBoundedStderr(0), /stderr cap/)
})
