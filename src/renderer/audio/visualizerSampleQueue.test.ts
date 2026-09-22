import assert from 'node:assert/strict'
import test from 'node:test'
import { createMonoSampleQueue, createStereoSampleQueue, createMultichannelSampleQueue, createMiniSampleQueue } from './visualizerSampleQueue.ts'

test('normal drains preserve chunks by reference and overflow keeps the latest audio without copying', () => {
  for (const rate of [44100, 48000, 96000, 192000]) {
    const queue = createMonoSampleQueue()
    const chunk = new Float32Array(800)
    queue.push(chunk, rate / 4)
    assert.equal(queue.drain()[0], chunk)
    assert.equal(queue.length, 0)
    const large = Float32Array.from({ length: rate }, (_, i) => i)
    queue.push(large, rate / 4)
    const retained = queue.drain()[0]
    assert.equal(retained.length, rate / 4)
    assert.equal(retained[0], rate * 3 / 4)
    assert.equal(retained.buffer, large.buffer)
  }
})

test('overflow trims the oldest partial chunk and keeps channels aligned', () => {
  const left = Float32Array.of(1, 2, 3, 4)
  const right = Float32Array.of(11, 12, 13, 14)
  const stereo = createStereoSampleQueue()
  stereo.push({ left, right }, 6)
  stereo.push({ left, right }, 6)
  assert.deepEqual(stereo.drain().map(c => [Array.from(c.left), Array.from(c.right)]), [
    [[3, 4], [13, 14]], [[1, 2, 3, 4], [11, 12, 13, 14]],
  ])
  const multi = createMultichannelSampleQueue()
  multi.push({ channels: [left, right, left, right, left, right] }, 2)
  assert.deepEqual(multi.drain()[0].channels.map(c => Array.from(c)), [[3, 4], [13, 14], [3, 4], [13, 14], [3, 4], [13, 14]])
  const mini = createMiniSampleQueue()
  mini.push({ left: new Float32Array(), mono: right }, 2)
  assert.deepEqual(Array.from(mini.drain()[0].mono), [13, 14])
})
