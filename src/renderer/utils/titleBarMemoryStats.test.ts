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
    footprintMb: 760,
    appProcessFootprintMb: 640,
    childProcessFootprintMb: 120,
    footprintSource: 'macos-private-resident',
    footprintComplete: true,
    footprintFailedPids: [],
    footprintProcessCount: 5,
    footprintAppProcessCount: 4,
    footprintChildProcessCount: 1,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 640)
  assert.equal(sample.childProcessFootprintMb, 120)
  assert.equal(sample.combinedFootprintMb, 760)
  assert.equal(sample.appFootprintSource, 'macos-private-resident')
  assert.equal(sample.rendererHeapUsedMb, 700)
  assert.equal(sample.bufferMemoryMb, 1200)
  assert.equal(sample.totalPrivateMb, 800)
  assert.equal(sample.totalWorkingSetMb, 2200)
})

test('title bar sample uses the complete windows native footprint', () => {
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
    footprintMb: 1720,
    appProcessFootprintMb: 1600,
    childProcessFootprintMb: 120,
    footprintSource: 'windows-private-working-set',
    footprintComplete: true,
    footprintFailedPids: [],
    footprintProcessCount: 5,
    footprintAppProcessCount: 4,
    footprintChildProcessCount: 1,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 1600)
  assert.equal(sample.childProcessFootprintMb, 120)
  assert.equal(sample.combinedFootprintMb, 1720)
  assert.equal(sample.appFootprintSource, 'windows-private-working-set')
  assert.equal(sample.rendererHeapUsedMb, 700)
  assert.equal(sample.bufferMemoryMb, 1200)
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
    appProcessFootprintMb: null,
    childProcessFootprintMb: null,
    footprintSource: 'unavailable',
    footprintComplete: false,
    footprintFailedPids: [10, 11, 10],
    footprintProcessCount: 4,
    footprintAppProcessCount: 4,
    footprintChildProcessCount: 0,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 800)
  assert.equal(sample.childProcessFootprintMb, 0)
  assert.equal(sample.combinedFootprintMb, 800)
  assert.equal(sample.appFootprintSource, 'fallback-private-working-set')
  assert.equal(sample.appFootprintComplete, false)
  assert.deepEqual(sample.appFootprintFailedPids, [10, 11])
})

test('title bar sample leaves combined footprint unknown when child footprint is missing', () => {
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
    appProcessFootprintMb: null,
    childProcessFootprintMb: null,
    footprintSource: 'unavailable',
    footprintComplete: false,
    footprintFailedPids: [200],
    footprintProcessCount: 5,
    footprintAppProcessCount: 4,
    footprintChildProcessCount: 1,
    bufferMemoryMb: 1200,
    currentBufferMemoryMb: 800,
    nextBufferMemoryMb: 400
  })

  assert.equal(sample.appFootprintMb, 800)
  assert.equal(sample.childProcessFootprintMb, null)
  assert.equal(sample.combinedFootprintMb, null)
})
