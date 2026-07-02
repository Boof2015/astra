import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTitleBarSample, BYTES_PER_MB } from './titleBarMemoryStats'

test('title bar sample does not add JS heap or audio buffers to app footprint', () => {
  const sample = buildTitleBarSample({
    sampledAt: 123,
    rendererPrivateMb: 300,
    rendererHeapUsedBytes: 700 * BYTES_PER_MB,
    rendererExternalBytes: null,
    rendererArrayBuffersBytes: null,
    rendererOldSpaceUsedBytes: null,
    rendererLargeObjectSpaceUsedBytes: null,
    mainRssBytes: null,
    mainHeapUsedBytes: null,
    mainExternalBytes: null,
    mainArrayBuffersBytes: null,
    privateMemoryExcludingRendererMb: 500,
    mainProcessMemoryMb: 350,
    helperProcessesMemoryMb: 150,
    totalWorkingSetMb: 2200,
    footprintMb: 640,
    footprintSource: 'macos-private-resident',
    footprintComplete: true,
    footprintFailedPids: [],
    footprintProcessCount: 4,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 640)
  assert.equal(sample.appFootprintSource, 'macos-private-resident')
  assert.equal(sample.rendererHeapUsedMb, 700)
  assert.equal(sample.bufferMemoryMb, 1200)
  assert.equal(sample.totalPrivateMb, 800)
  assert.equal(sample.totalWorkingSetMb, 2200)
})

test('title bar sample falls back to private hybrid when native footprint is unavailable', () => {
  const sample = buildTitleBarSample({
    sampledAt: 123,
    rendererPrivateMb: 300,
    rendererHeapUsedBytes: null,
    rendererExternalBytes: null,
    rendererArrayBuffersBytes: null,
    rendererOldSpaceUsedBytes: null,
    rendererLargeObjectSpaceUsedBytes: null,
    mainRssBytes: null,
    mainHeapUsedBytes: null,
    mainExternalBytes: null,
    mainArrayBuffersBytes: null,
    privateMemoryExcludingRendererMb: 500,
    mainProcessMemoryMb: 350,
    helperProcessesMemoryMb: 150,
    totalWorkingSetMb: 2200,
    footprintMb: null,
    footprintSource: 'unavailable',
    footprintComplete: false,
    footprintFailedPids: [10, 11, 10],
    footprintProcessCount: 4,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 800)
  assert.equal(sample.appFootprintSource, 'fallback-private-working-set')
  assert.equal(sample.appFootprintComplete, false)
  assert.deepEqual(sample.appFootprintFailedPids, [10, 11])
})
