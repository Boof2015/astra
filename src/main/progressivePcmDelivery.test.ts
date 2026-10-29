import assert from 'node:assert/strict'
import test from 'node:test'
import { ProgressivePcmDelivery } from './progressivePcmDelivery.ts'
import { resolveLocalProgressiveBackpressureAction } from './progressiveStreamBackpressure.ts'

test('local successor preserves every startup sample until the renderer attaches, including early EOF', () => {
  const samples = Float32Array.from({ length: 48_000 * 2 }, (_, index) => index)
  const input = Buffer.from(samples.buffer)
  const chunks: Buffer[] = []
  let rendererReady = false
  let stdoutPaused = false
  let decodedFrames = 0
  const delivery = new ProgressivePcmDelivery(2, () => decodedFrames < 16_384 ? 8192 : 65_536,
    () => !stdoutPaused && (decodedFrames === 0 || rendererReady), chunk => {
      chunks.push(chunk)
      decodedFrames += chunk.length / 8
      stdoutPaused = resolveLocalProgressiveBackpressureAction({ sampleRate: 48_000, decodedFrames,
        consumedFrames: 0, rendererReady, stdoutPaused, startupFrames: 8192 }) === 'pause'
    })
  delivery.push(input)
  assert.equal(chunks.length, 1, 'only the startup response owns PCM before attachment')
  delivery.finish()
  assert.equal(delivery.drained, false, 'EOF must retain PCM awaiting attachment')
  rendererReady = true
  stdoutPaused = false
  delivery.drain()
  assert.equal(delivery.drained, true)
  assert.equal(chunks[1].length / 8, 8192, 'preserve small startup chunks before the steady batch')
  assert.deepEqual(Buffer.concat(chunks), input, 'no samples are dropped, repeated or reordered')
})

test('one large stdout chunk cannot outrun renderer startup or paused decode credits', () => {
  let credits = 1
  const chunks: Buffer[] = []
  const input = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
  const delivery = new ProgressivePcmDelivery(2, 4, () => credits > 0, chunk => { chunks.push(chunk); credits-- })
  delivery.push(input)
  assert.equal(chunks.length, 1)
  delivery.finish()
  assert.equal(delivery.drained, false, 'decoder EOF cannot discard held startup PCM')
  credits = 3
  delivery.drain()
  assert.equal(chunks.length, 4)
  assert.equal(delivery.drained, false)
  credits = 4
  delivery.drain()
  assert.equal(delivery.drained, true)
  assert.deepEqual(Buffer.concat(chunks), input)
})

test('short tracks flush their final frames, including a split PCM frame', () => {
  const chunks: Buffer[] = []
  const delivery = new ProgressivePcmDelivery(2, 4096, () => true, chunk => chunks.push(chunk))
  delivery.push(Buffer.from([1, 2, 3]))
  delivery.push(Buffer.from([4, 5, 6, 7, 8]))
  assert.equal(chunks.length, 0)
  delivery.finish()
  assert.deepEqual([...chunks[0]], [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(delivery.drained, true)
})
