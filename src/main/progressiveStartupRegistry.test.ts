import assert from 'node:assert/strict'
import test from 'node:test'
import { ProgressiveStartupRegistry } from './progressiveStartupRegistry.ts'

test('preparation cannot interrupt current startup; interactive startup cancels obsolete preparation', () => {
  const registry = new ProgressiveStartupRegistry()
  const current = registry.begin(1, 'current')
  const next = registry.begin(1, 'next')
  const other = registry.begin(2, 'next')
  assert.equal(current.signal.aborted, false)
  const replacement = registry.begin(1, 'current')
  assert.equal(current.signal.aborted, true)
  assert.equal(next.signal.aborted, true)
  assert.equal(other.signal.aborted, false)
  registry.finish(1, 'current', current)
  registry.cancel(1, 'current')
  assert.equal(replacement.signal.aborted, true, 'late completion must not remove the newer startup')
  registry.cancelAll()
  assert.equal(other.signal.aborted, true)
})

test('clearing next startup leaves current playback startup alone', () => {
  const registry = new ProgressiveStartupRegistry()
  const current = registry.begin(1, 'current')
  const obsolete = registry.begin(1, 'next')
  const next = registry.begin(1, 'next')
  assert.equal(obsolete.signal.aborted, true)
  registry.finish(1, 'next', obsolete)
  registry.cancel(1, 'next')
  assert.equal(next.signal.aborted, true)
  assert.equal(current.signal.aborted, false)
})

test('seeking replaces only current startup and keeps the pending successor', () => {
  const registry = new ProgressiveStartupRegistry()
  const current = registry.begin(1, 'current')
  const next = registry.begin(1, 'next')
  const seek = registry.begin(1, 'current', true)
  assert.equal(current.signal.aborted, true)
  assert.equal(next.signal.aborted, false)
  registry.cancel(1, 'current')
  const finalSeek = registry.begin(1, 'current', true)
  assert.equal(seek.signal.aborted, true)
  assert.equal(next.signal.aborted, false)
  registry.begin(1, 'current')
  assert.equal(finalSeek.signal.aborted, true)
  assert.equal(next.signal.aborted, true, 'a real track switch still cancels preparation')
})
