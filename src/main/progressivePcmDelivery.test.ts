import assert from 'node:assert/strict'
import test from 'node:test'
import { ProgressivePcmDelivery } from './progressivePcmDelivery.ts'

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
