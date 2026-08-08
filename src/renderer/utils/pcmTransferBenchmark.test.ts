import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PCM_TRANSFER_BENCHMARK_MAX_BYTES,
  PCM_TRANSFER_BENCHMARK_SENTINELS,
  createPcmTransferBenchmarkProbe,
  validatePcmTransferBenchmarkProbe
} from '../../shared/pcmTransferBenchmark'
import {
  PCM_TRANSFER_BENCHMARK_REPETITIONS,
  PCM_TRANSFER_BENCHMARK_SIZES_BYTES,
  calculatePcmTransferResidualMs,
  createMainPortPcmTransferBenchmarkProbe,
  createPcmTransferBenchmarkPlan,
  medianPcmTransferMetric,
  runPcmTransferBenchmark
} from './pcmTransferBenchmark'
import type { PcmTransferBenchmarkProbeResult } from '../../types/diagnostics'
import type {
  LocalPcmStreamClient,
  LocalPcmStreamDecodeResult
} from '../audio/localPcmStreamClient'
import type { MainPortPcmTransferBenchmarkProbeResult } from './pcmTransferBenchmark'

function createMainProbe(sizeBytes: number): PcmTransferBenchmarkProbeResult {
  return {
    ...createPcmTransferBenchmarkProbe(sizeBytes),
    mainHandlerMs: 2,
    preloadInvokeMs: 4
  }
}

function createPreloadProbe(sizeBytes: number): PcmTransferBenchmarkProbeResult {
  return {
    ...createPcmTransferBenchmarkProbe(sizeBytes),
    preloadServiceMs: 3
  }
}

function createPortProbe(sizeBytes: number): MainPortPcmTransferBenchmarkProbeResult {
  return {
    sizeBytes,
    payloadByteLength: sizeBytes,
    payloadValid: true,
    mainHandlerMs: 10,
    mainGenerationMs: 1,
    mainAllocationMs: 0.5,
    mainFillMs: 2,
    streamDispatchCopyMs: 3,
    streamDispatchPostMs: 4,
    rendererPcmAssemblyAllocationMs: 5,
    rendererPcmAssemblyCopyMs: 6,
    rendererPcmAssemblyMs: 11,
    rendererPortRequestMs: 14,
    streamChunkCount: 2,
    streamTailMs: 1.5,
    overlapTailResidualMs: 4
  }
}

test('PCM transfer payload validation checks length and fixed sentinel bytes', () => {
  const probe = createPcmTransferBenchmarkProbe(16)
  assert.equal(validatePcmTransferBenchmarkProbe(probe, 16), true)

  new Uint8Array(probe.payload)[Math.floor(probe.payload.byteLength / 2)] = 0
  assert.equal(validatePcmTransferBenchmarkProbe(probe, 16), false)

  const wrongLength = createPcmTransferBenchmarkProbe(15)
  assert.equal(validatePcmTransferBenchmarkProbe(wrongLength, 16), false)
  assert.deepEqual(PCM_TRANSFER_BENCHMARK_SENTINELS, {
    first: 0xa5,
    middle: 0x5a,
    last: 0xc3
  })
})

test('PCM transfer benchmark size validation enforces the 72 MiB endpoint cap', () => {
  assert.doesNotThrow(() => createPcmTransferBenchmarkPlan([PCM_TRANSFER_BENCHMARK_MAX_BYTES], 1, 1))
  assert.throws(
    () => createPcmTransferBenchmarkPlan([PCM_TRANSFER_BENCHMARK_MAX_BYTES + 1], 1, 1),
    /between 1 byte and 72 MiB/
  )
  assert.throws(() => createPcmTransferBenchmarkPlan([1.5], 1, 1), /between 1 byte and 72 MiB/)
  assert.throws(() => createPcmTransferBenchmarkPlan([1], 0, 1), /positive integer/)
})

test('PCM transfer residuals clamp negative reconciliation differences to zero', () => {
  assert.equal(calculatePcmTransferResidualMs(12.5, 8.25), 4.25)
  assert.equal(calculatePcmTransferResidualMs(8, 12), 0)
  assert.throws(() => calculatePcmTransferResidualMs(Number.NaN, 1), /invalid encompassing duration/)
})

test('PCM transfer medians are stable for odd and even sample counts', () => {
  const oddSamples = [9, 1, 5]
  assert.equal(medianPcmTransferMetric(oddSamples), 5)
  assert.equal(medianPcmTransferMetric([8, 2, 4, 6]), 5)
  assert.deepEqual(oddSamples, [9, 1, 5], 'median calculation must not mutate the input')
  assert.throws(() => medianPcmTransferMetric([]), /without samples/)
})

test('port benchmark probe validates sentinels, extracts stream timings, and releases PCM', async () => {
  const payload = new ArrayBuffer(8)
  const bytes = new Uint8Array(payload)
  bytes.fill(0x6d)
  bytes[0] = PCM_TRANSFER_BENCHMARK_SENTINELS.first
  bytes[4] = PCM_TRANSFER_BENCHMARK_SENTINELS.middle
  bytes[7] = PCM_TRANSFER_BENCHMARK_SENTINELS.last
  const result: LocalPcmStreamDecodeResult = {
    requestId: 1,
    sampleRate: 48_000,
    channels: 1,
    frames: 2,
    pcmByteLength: 8,
    interleavedPcm: payload,
    probeMs: 0,
    decodeMs: 0,
    backgroundPriorityApplied: false,
    transportTimings: {
      decodeRequestId: 1,
      validPcmBytes: 8,
      backingBufferBytes: 8,
      allocationGrowthCount: 0,
      transportRoute: 'message_port_stream',
      mainHandlerMs: 15,
      binaryResolutionMs: 0,
      probeMs: 0,
      ffmpegMs: 0,
      allocationMs: 1,
      initialAllocationMs: 1,
      growthAllocationMs: 0,
      payloadFinalizationMs: 0,
      preloadInvokeMs: 0,
      streamChunkCount: 1,
      streamDispatchCopyMs: 2,
      streamDispatchPostMs: 3,
      streamTailMs: 4,
      rendererPcmAssemblyAllocationMs: 5,
      rendererPcmAssemblyCopyMs: 6,
      rendererPortRequestMs: 19,
      benchmarkMainGenerationMs: 7,
      benchmarkMainFillMs: 8
    } as LocalPcmStreamDecodeResult['transportTimings'] & {
      benchmarkMainGenerationMs: number
      benchmarkMainFillMs: number
    }
  }
  const client: LocalPcmStreamClient = {
    decode: async () => result,
    cancel: () => false,
    dispose: () => undefined,
    hasPending: () => false,
    pendingCount: 0
  }

  const probe = await createMainPortPcmTransferBenchmarkProbe(client)(8)
  assert.deepEqual(probe, {
    sizeBytes: 8,
    payloadByteLength: 8,
    payloadValid: true,
    mainHandlerMs: 15,
    mainGenerationMs: 7,
    mainAllocationMs: 1,
    mainFillMs: 8,
    streamDispatchCopyMs: 2,
    streamDispatchPostMs: 3,
    rendererPcmAssemblyAllocationMs: 5,
    rendererPcmAssemblyCopyMs: 6,
    rendererPcmAssemblyMs: 11,
    rendererPortRequestMs: 19,
    streamChunkCount: 1,
    streamTailMs: 4,
    overlapTailResidualMs: 4
  })
  assert.equal(result.interleavedPcm.byteLength, 0, 'large PCM result must be released after validation')
})

test('default PCM transfer plan warms all routes once then runs three sequential repetitions per size', () => {
  const plan = createPcmTransferBenchmarkPlan()
  assert.equal(plan.length, 3 + (PCM_TRANSFER_BENCHMARK_SIZES_BYTES.length * PCM_TRANSFER_BENCHMARK_REPETITIONS * 3))
  assert.deepEqual(plan.slice(0, 3), [
    {
      route: 'main-ipc-bridge',
      sizeBytes: PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0],
      repetition: null,
      warmup: true
    },
    {
      route: 'preload-bridge-only',
      sizeBytes: PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0],
      repetition: null,
      warmup: true
    },
    {
      route: 'main-port-stream',
      sizeBytes: PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0],
      repetition: null,
      warmup: true
    }
  ])

  const measuredOrder = plan.slice(3).map((step) => (
    `${step.sizeBytes}:${step.repetition}:${step.route}`
  ))
  assert.deepEqual(measuredOrder.slice(0, 9), [
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:1:main-ipc-bridge`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:1:preload-bridge-only`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:1:main-port-stream`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:2:main-ipc-bridge`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:2:preload-bridge-only`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:2:main-port-stream`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:3:main-ipc-bridge`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:3:preload-bridge-only`,
    `${PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]}:3:main-port-stream`
  ])
})

test('runner defers non-sampling raw logs until every transfer finishes and snapshots only completion', async () => {
  const activity: string[] = []
  const logged: Array<{
    name: string
    captureSample: boolean | undefined
    details: Record<string, unknown> | null | undefined
  }> = []
  let monotonicMs = 0
  const wallTimes = [1_000, 2_000]

  const summary = await runPcmTransferBenchmark({
    benchmarkMainPcmTransfer: async (sizeBytes) => {
      activity.push(`probe:main:${sizeBytes}`)
      return createMainProbe(sizeBytes)
    },
    benchmarkPreloadPcmTransfer: (sizeBytes) => {
      activity.push(`probe:preload:${sizeBytes}`)
      return createPreloadProbe(sizeBytes)
    },
    benchmarkMainPortPcmTransfer: async (sizeBytes) => {
      activity.push(`probe:port:${sizeBytes}`)
      return createPortProbe(sizeBytes)
    },
    logEvent: async (payload, options) => {
      activity.push(`log:${payload.name}`)
      logged.push({
        name: payload.name,
        captureSample: options?.captureSample,
        details: payload.details
      })
      return true
    }
  }, {
    benchmarkId: 'benchmark-test',
    sizesBytes: [16],
    repetitions: 3,
    warmupSizeBytes: 8,
    monotonicNow: () => {
      monotonicMs += 5
      return monotonicMs
    },
    wallNow: () => wallTimes.shift() ?? 2_000
  })

  const firstLogIndex = activity.findIndex((entry) => entry.startsWith('log:'))
  assert.equal(firstLogIndex, 12, 'three warm-ups and nine measured probes must finish before logging starts')
  assert.equal(activity.slice(0, firstLogIndex).every((entry) => entry.startsWith('probe:')), true)
  assert.equal(logged.length, 10)
  assert.equal(logged.slice(0, -1).every((entry) => (
    entry.name === 'pcm_transfer_benchmark_sample' && entry.captureSample === false
  )), true)
  assert.deepEqual(logged.at(-1), {
    name: 'pcm_transfer_benchmark_completed',
    captureSample: true,
    details: {
      ...summary,
      residualInterpretation: 'Residuals include scheduling and dispatch overhead and do not prove a memcpy count. Port overlap/tail residual is renderer request wall time minus main handler wall time, clamped to zero.'
    }
  })

  assert.equal(summary.sizes[0].main.electronIpcResidualMs, 2)
  assert.equal(summary.sizes[0].main.contextBridgeResidualMs, 1)
  assert.equal(summary.sizes[0].preload.contextBridgeResidualMs, 2)
  assert.equal(summary.sizes[0].port.rendererPortRequestMs, 14)
  assert.equal(summary.sizes[0].port.rendererPcmAssemblyMs, 11)
  assert.equal(summary.sizes[0].port.overlapTailResidualMs, 4)
})
