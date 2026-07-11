import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUnavailableAppMemoryFootprintSummary,
  resolveTitleBarAppFootprint,
  summarizeNativeProcessMemoryFootprints,
  type NativeProcessMemoryFootprintsResult
} from './processMemoryFootprint'

const MB = 1024 * 1024

test('summarizes successful native process footprint samples', () => {
  const result: NativeProcessMemoryFootprintsResult = {
    source: 'linux-pss',
    totalBytes: 3 * MB,
    complete: true,
    failedPids: [],
    processes: [
      { pid: 100, source: 'linux-pss', ok: true, bytes: MB },
      { pid: 101, source: 'linux-pss', ok: true, bytes: 2 * MB }
    ]
  }

  const summary = summarizeNativeProcessMemoryFootprints(result, [100, 101], 2048)

  assert.equal(summary.footprintMb, 3)
  assert.equal(summary.appProcessFootprintMb, 3)
  assert.equal(summary.childProcessFootprintMb, null)
  assert.equal(summary.footprintSource, 'linux-pss')
  assert.equal(summary.footprintComplete, true)
  assert.deepEqual(summary.footprintFailedPids, [])
  assert.equal(summary.footprintProcessCount, 2)
  assert.equal(summary.footprintAppProcessCount, 2)
  assert.equal(summary.footprintChildProcessCount, 0)
  assert.equal(summary.footprintRawWorkingSetMb, 2048)
})

test('separates app process footprint from child process footprint', () => {
  const result: NativeProcessMemoryFootprintsResult = {
    source: 'windows-private-working-set',
    totalBytes: 10 * MB,
    complete: true,
    failedPids: [],
    processes: [
      { pid: 100, source: 'windows-private-working-set', ok: true, bytes: MB },
      { pid: 101, source: 'windows-private-working-set', ok: true, bytes: 2 * MB },
      { pid: 200, source: 'windows-private-working-set', ok: true, bytes: 7 * MB }
    ]
  }

  const summary = summarizeNativeProcessMemoryFootprints(result, [100, 101, 200], 2048, {
    appPids: [100, 101],
    childPids: [200]
  })

  assert.equal(summary.footprintMb, 10)
  assert.equal(summary.appProcessFootprintMb, 3)
  assert.equal(summary.childProcessFootprintMb, 7)
  assert.equal(summary.footprintProcessCount, 3)
  assert.equal(summary.footprintAppProcessCount, 2)
  assert.equal(summary.footprintChildProcessCount, 1)
})

test('keeps partial footprint samples and reports failed or missing pids', () => {
  const result: NativeProcessMemoryFootprintsResult = {
    source: 'macos-private-resident',
    totalBytes: MB,
    complete: false,
    failedPids: [201],
    processes: [
      { pid: 200, source: 'macos-private-resident', ok: true, bytes: MB },
      { pid: 201, source: 'macos-private-resident', ok: false, bytes: null, error: 'denied' }
    ]
  }

  const summary = summarizeNativeProcessMemoryFootprints(result, [200, 201, 202], 512)

  assert.equal(summary.footprintMb, 1)
  assert.equal(summary.footprintComplete, false)
  assert.deepEqual(summary.footprintFailedPids.sort((a, b) => a - b), [201, 202])
  assert.equal(summary.footprintProcesses.find((entry) => entry.pid === 202)?.ok, false)
})

test('creates an unavailable summary when the native helper is missing', () => {
  const summary = createUnavailableAppMemoryFootprintSummary([300, 300, 301], 128)

  assert.equal(summary.footprintMb, null)
  assert.equal(summary.appProcessFootprintMb, null)
  assert.equal(summary.childProcessFootprintMb, null)
  assert.equal(summary.footprintSource, 'unavailable')
  assert.equal(summary.footprintComplete, false)
  assert.deepEqual(summary.footprintFailedPids, [300, 301])
  assert.equal(summary.footprintRawWorkingSetMb, 128)
})

test('title bar footprint resolution prefers complete macos and linux measured footprint over fallback totals', () => {
  for (const source of ['macos-private-resident', 'linux-pss'] as const) {
    const resolution = resolveTitleBarAppFootprint({
      measuredFootprintMb: 420,
      measuredSource: source,
      measuredComplete: true,
      fallbackPrivateMb: 900
    })

    assert.deepEqual(resolution, {
      appFootprintMb: 420,
      appFootprintSource: source,
      appFootprintComplete: true
    })
  }
})

test('title bar footprint resolution prefers complete windows native footprint over fallback totals', () => {
  const resolution = resolveTitleBarAppFootprint({
    measuredFootprintMb: 420,
    measuredSource: 'windows-private-working-set',
    measuredComplete: true,
    fallbackPrivateMb: 800
  })

  assert.deepEqual(resolution, {
    appFootprintMb: 420,
    appFootprintSource: 'windows-private-working-set',
    appFootprintComplete: true
  })
})

test('title bar footprint resolution falls back when the windows native footprint is incomplete', () => {
  const resolution = resolveTitleBarAppFootprint({
    measuredFootprintMb: 420,
    measuredSource: 'windows-private-working-set',
    measuredComplete: false,
    fallbackPrivateMb: 800
  })

  assert.deepEqual(resolution, {
    appFootprintMb: 800,
    appFootprintSource: 'fallback-private-working-set',
    appFootprintComplete: false
  })
})

test('title bar footprint resolution prefers private hybrid over incomplete native footprint', () => {
  const resolution = resolveTitleBarAppFootprint({
    measuredFootprintMb: 420,
    measuredSource: 'macos-private-resident',
    measuredComplete: false,
    fallbackPrivateMb: 256
  })

  assert.deepEqual(resolution, {
    appFootprintMb: 256,
    appFootprintSource: 'fallback-private-working-set',
    appFootprintComplete: false
  })
})

test('title bar footprint resolution falls back to the legacy private working-set estimate', () => {
  const resolution = resolveTitleBarAppFootprint({
    measuredFootprintMb: null,
    measuredSource: 'unavailable',
    measuredComplete: false,
    fallbackPrivateMb: 256
  })

  assert.deepEqual(resolution, {
    appFootprintMb: 256,
    appFootprintSource: 'fallback-private-working-set',
    appFootprintComplete: false
  })
})

test('title bar footprint resolution uses measured footprint when no fallback exists', () => {
  const resolution = resolveTitleBarAppFootprint({
    measuredFootprintMb: 420,
    measuredSource: 'windows-private-working-set',
    measuredComplete: true,
    fallbackPrivateMb: null
  })

  assert.deepEqual(resolution, {
    appFootprintMb: 420,
    appFootprintSource: 'windows-private-working-set',
    appFootprintComplete: true
  })
})
