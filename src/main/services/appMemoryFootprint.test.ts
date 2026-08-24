import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProcessMetric } from 'electron'
import {
  createAppMemoryFootprintCollector,
  type NativeProcessMemoryAddon
} from './appMemoryFootprint'
import type { NativeProcessMemoryFootprintsResult } from '../../shared/processMemoryFootprint'

function processMetric(pid: number): ProcessMetric {
  return { pid } as ProcessMetric
}

function resultFor(pids: readonly number[]): NativeProcessMemoryFootprintsResult {
  return {
    source: 'macos-private-resident',
    totalBytes: pids.length * 1024,
    complete: true,
    failedPids: [],
    processes: pids.map((pid) => ({
      pid,
      source: 'macos-private-resident',
      ok: true,
      bytes: 1024,
      error: null
    }))
  }
}

test('deduplicates concurrent async measurements for the same process set', async () => {
  let resolveMeasurement: ((result: NativeProcessMemoryFootprintsResult) => void) | undefined
  const pendingMeasurement = new Promise<NativeProcessMemoryFootprintsResult>((resolve) => {
    resolveMeasurement = resolve
  })
  const measuredPidSets: number[][] = []
  const addon: NativeProcessMemoryAddon = {
    processMemory: {
      getProcessFootprintsAsync: async (pids) => {
        measuredPidSets.push([...pids])
        return pendingMeasurement
      }
    }
  }
  const collect = createAppMemoryFootprintCollector(() => addon)

  const first = collect({
    metrics: [processMetric(20), processMetric(10)],
    extraPids: [30],
    rawWorkingSetMb: 50
  })
  const second = collect({
    metrics: [processMetric(10), processMetric(20)],
    extraPids: [30],
    rawWorkingSetMb: 60
  })

  await Promise.resolve()
  assert.deepEqual(measuredPidSets, [[20, 10, 30]])
  resolveMeasurement?.(resultFor([20, 10, 30]))

  const [firstSummary, secondSummary] = await Promise.all([first, second])
  assert.equal(firstSummary.footprintMb, 3 / 1024)
  assert.equal(secondSummary.footprintMb, 3 / 1024)
  assert.equal(firstSummary.footprintRawWorkingSetMb, 50)
  assert.equal(secondSummary.footprintRawWorkingSetMb, 60)
})

test('never falls back to the synchronous native memory walk at runtime', async () => {
  let synchronousCalls = 0
  const collect = createAppMemoryFootprintCollector(() => ({
    processMemory: {
      getProcessFootprints: (pids) => {
        synchronousCalls += 1
        return resultFor(pids)
      }
    }
  }))

  const summary = await collect({
    metrics: [processMetric(10)],
    rawWorkingSetMb: 25
  })

  assert.equal(synchronousCalls, 0)
  assert.equal(summary.footprintMb, null)
  assert.equal(summary.footprintSource, 'unavailable')
  assert.deepEqual(summary.footprintFailedPids, [10])
})

test('clears failed in-flight measurements so the next sample can retry', async () => {
  let calls = 0
  const collect = createAppMemoryFootprintCollector(() => ({
    processMemory: {
      getProcessFootprintsAsync: async (pids) => {
        calls += 1
        if (calls === 1) throw new Error('temporary failure')
        return resultFor(pids)
      }
    }
  }))

  const originalWarn = console.warn
  console.warn = () => undefined
  try {
    const failed = await collect({ metrics: [processMetric(10)], rawWorkingSetMb: 25 })
    const retried = await collect({ metrics: [processMetric(10)], rawWorkingSetMb: 25 })

    assert.equal(failed.footprintMb, null)
    assert.equal(retried.footprintMb, 1 / 1024)
    assert.equal(calls, 2)
  } finally {
    console.warn = originalWarn
  }
})
