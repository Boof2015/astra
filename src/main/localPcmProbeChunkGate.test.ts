import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalPcmProbeChunkGate } from './localPcmProbeChunkGate.ts'

test('holds pre-probe PCM in order and passes later chunks through', () => {
  const gate = new LocalPcmProbeChunkGate(16)
  const consumed: number[][] = []
  const consume = (chunk: Buffer): void => {
    consumed.push(Array.from(chunk))
  }

  gate.accept(Buffer.from([1, 2]), consume)
  gate.accept(Buffer.from([3]), consume)
  assert.equal(gate.pendingByteLength, 3)
  assert.equal(gate.isReleased, false)
  assert.deepEqual(consumed, [])

  gate.release(consume)
  assert.equal(gate.pendingByteLength, 0)
  assert.equal(gate.isReleased, true)
  assert.deepEqual(consumed, [[1, 2], [3]])

  gate.accept(Buffer.from([4, 5]), consume)
  gate.release(consume)
  assert.deepEqual(consumed, [[1, 2], [3], [4, 5]])
})

test('enforces the pending-byte cap without retaining the rejected chunk', () => {
  const gate = new LocalPcmProbeChunkGate(3)
  const consumed: Buffer[] = []
  gate.accept(Buffer.from([1, 2]), (chunk) => consumed.push(chunk))

  assert.throws(
    () => gate.accept(Buffer.from([3, 4]), (chunk) => consumed.push(chunk)),
    /exceeded the Standard playback limit/
  )
  assert.equal(gate.pendingByteLength, 2)

  gate.release((chunk) => consumed.push(chunk))
  assert.deepEqual(consumed.map((chunk) => Array.from(chunk)), [[1, 2]])
})

test('clear releases retained chunks without opening the gate', () => {
  const gate = new LocalPcmProbeChunkGate(8)
  const consumed: Buffer[] = []
  gate.accept(Buffer.from([1, 2, 3]), (chunk) => consumed.push(chunk))
  gate.clear()

  assert.equal(gate.pendingByteLength, 0)
  assert.equal(gate.isReleased, false)
  gate.release((chunk) => consumed.push(chunk))
  assert.deepEqual(consumed, [])
})

test('rejects invalid pending-byte caps', () => {
  assert.throws(() => new LocalPcmProbeChunkGate(0), /positive byte cap/)
  assert.throws(() => new LocalPcmProbeChunkGate(Number.MAX_SAFE_INTEGER + 1), /positive byte cap/)
})
