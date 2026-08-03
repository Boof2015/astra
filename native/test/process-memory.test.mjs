import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { processMemory } = require('../build/Release/visualizer_dsp.node')

test('exports compatible synchronous and asynchronous process footprint methods', async () => {
  assert.equal(typeof processMemory.getProcessFootprints, 'function')
  assert.equal(typeof processMemory.getProcessFootprintsAsync, 'function')

  const synchronous = processMemory.getProcessFootprints([process.pid])
  const pending = processMemory.getProcessFootprintsAsync([process.pid])
  assert.equal(typeof pending?.then, 'function')
  const asynchronous = await pending

  assert.equal(asynchronous.source, synchronous.source)
  assert.equal(asynchronous.complete, synchronous.complete)
  assert.deepEqual(asynchronous.failedPids, synchronous.failedPids)
  assert.equal(asynchronous.processes.length, 1)
  assert.equal(asynchronous.processes[0].pid, process.pid)
  assert.equal(asynchronous.processes[0].source, synchronous.processes[0].source)
  assert.equal(asynchronous.processes[0].ok, synchronous.processes[0].ok)
  assert.equal(typeof asynchronous.totalBytes, 'number')
})

test('validates async process ids before queueing native work', () => {
  assert.throws(
    () => processMemory.getProcessFootprintsAsync(['not-a-pid']),
    /Process ids must be numbers/
  )
})
