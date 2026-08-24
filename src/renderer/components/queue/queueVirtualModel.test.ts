import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createQueueVirtualLayout,
  resolveQueueDropIndex,
  resolveQueueVirtualRowLocation
} from './queueVirtualModel.ts'

test('queue virtual layout preserves section and track ordering', () => {
  const layout = createQueueVirtualLayout(true, 21_500, 3)

  assert.equal(layout.rowCount, 21_507)
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 0), {
    kind: 'section',
    section: 'current'
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 1), { kind: 'current' })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 2), {
    kind: 'section',
    section: 'upcoming'
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 3), {
    kind: 'upcoming',
    itemIndex: 0
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 21_502), {
    kind: 'upcoming',
    itemIndex: 21_499
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 21_503), {
    kind: 'section',
    section: 'previous'
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(layout, 21_506), {
    kind: 'previous',
    itemIndex: 2
  })
})

test('queue virtual layout handles independently empty sections', () => {
  const previousOnly = createQueueVirtualLayout(false, 0, 2)
  assert.equal(previousOnly.rowCount, 3)
  assert.deepEqual(resolveQueueVirtualRowLocation(previousOnly, 0), {
    kind: 'section',
    section: 'previous'
  })
  assert.deepEqual(resolveQueueVirtualRowLocation(previousOnly, 2), {
    kind: 'previous',
    itemIndex: 1
  })

  const empty = createQueueVirtualLayout(false, 0, 0)
  assert.equal(empty.rowCount, 0)
  assert.equal(resolveQueueVirtualRowLocation(empty, 0), null)
  assert.equal(resolveQueueVirtualRowLocation(previousOnly, -1), null)
  assert.equal(resolveQueueVirtualRowLocation(previousOnly, 3), null)
})

test('queue drop index matches midpoint insertion behavior in constant time', () => {
  assert.equal(resolveQueueDropIndex(-500, 56, 21_500), 0)
  assert.equal(resolveQueueDropIndex(27.9, 56, 21_500), 0)
  assert.equal(resolveQueueDropIndex(28, 56, 21_500), 1)
  assert.equal(resolveQueueDropIndex(56 * 12 + 27, 56, 21_500), 12)
  assert.equal(resolveQueueDropIndex(56 * 12 + 28, 56, 21_500), 13)
  assert.equal(resolveQueueDropIndex(Number.MAX_SAFE_INTEGER, 56, 21_500), 21_500)
})
