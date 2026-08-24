import {
  PCM_TRANSFER_BENCHMARK_MAX_BYTES,
  PCM_TRANSFER_BENCHMARK_SENTINELS,
  normalizePcmTransferBenchmarkSize,
  validatePcmTransferBenchmarkProbe
} from '../../shared/pcmTransferBenchmark'
import type {
  MemoryDiagnosticsEventPayload,
  PcmTransferBenchmarkProbeResult
} from '../../types/diagnostics'
import type {
  LocalPcmStreamClient,
  LocalPcmStreamDecodeResult
} from '../audio/localPcmStreamClient'

const MEBIBYTE = 1024 * 1024

export const PCM_TRANSFER_BENCHMARK_SIZES_BYTES = Object.freeze([
  1 * MEBIBYTE,
  16 * MEBIBYTE,
  PCM_TRANSFER_BENCHMARK_MAX_BYTES
])
export const PCM_TRANSFER_BENCHMARK_REPETITIONS = 3
export const PCM_TRANSFER_BENCHMARK_WARMUP_SIZE_BYTES = PCM_TRANSFER_BENCHMARK_SIZES_BYTES[0]

export type PcmTransferBenchmarkRoute =
  | 'main-ipc-bridge'
  | 'preload-bridge-only'
  | 'main-port-stream'

export interface PcmTransferBenchmarkPlanStep {
  route: PcmTransferBenchmarkRoute
  sizeBytes: number
  repetition: number | null
  warmup: boolean
}

interface PcmTransferBenchmarkSampleCommon {
  benchmarkId: string
  route: PcmTransferBenchmarkRoute
  sizeBytes: number
  sizeMiB: number
  repetition: number
  payloadByteLength: number
  payloadValid: true
}

interface PcmTransferBenchmarkLegacySampleBase extends PcmTransferBenchmarkSampleCommon {
  route: 'main-ipc-bridge' | 'preload-bridge-only'
  allocationMs: number
  fillMs: number
  rendererBridgeCallMs: number
}

export interface MainPcmTransferBenchmarkSample extends PcmTransferBenchmarkLegacySampleBase {
  route: 'main-ipc-bridge'
  mainHandlerMs: number
  preloadInvokeMs: number
  electronIpcResidualMs: number
  contextBridgeResidualMs: number
}

export interface PreloadPcmTransferBenchmarkSample extends PcmTransferBenchmarkLegacySampleBase {
  route: 'preload-bridge-only'
  preloadServiceMs: number
  contextBridgeResidualMs: number
}

export interface MainPortPcmTransferBenchmarkSample extends PcmTransferBenchmarkSampleCommon {
  route: 'main-port-stream'
  mainHandlerMs: number
  mainGenerationMs: number
  mainAllocationMs: number
  mainFillMs: number
  streamDispatchCopyMs: number
  streamDispatchPostMs: number
  rendererPcmAssemblyAllocationMs: number
  rendererPcmAssemblyCopyMs: number
  rendererPcmAssemblyMs: number
  rendererPortRequestMs: number
  streamChunkCount: number
  streamTailMs: number
  overlapTailResidualMs: number
}

export type PcmTransferBenchmarkSample =
  | MainPcmTransferBenchmarkSample
  | PreloadPcmTransferBenchmarkSample
  | MainPortPcmTransferBenchmarkSample

export interface MainPortPcmTransferBenchmarkProbeResult {
  sizeBytes: number
  payloadByteLength: number
  payloadValid: true
  mainHandlerMs: number
  mainGenerationMs: number
  mainAllocationMs: number
  mainFillMs: number
  streamDispatchCopyMs: number
  streamDispatchPostMs: number
  rendererPcmAssemblyAllocationMs: number
  rendererPcmAssemblyCopyMs: number
  rendererPcmAssemblyMs: number
  rendererPortRequestMs: number
  streamChunkCount: number
  streamTailMs: number
  overlapTailResidualMs: number
}

export interface PcmTransferBenchmarkMainMedians {
  allocationMs: number
  fillMs: number
  mainHandlerMs: number
  preloadInvokeMs: number
  rendererBridgeCallMs: number
  electronIpcResidualMs: number
  contextBridgeResidualMs: number
}

export interface PcmTransferBenchmarkPreloadMedians {
  allocationMs: number
  fillMs: number
  preloadServiceMs: number
  rendererBridgeCallMs: number
  contextBridgeResidualMs: number
}

export interface PcmTransferBenchmarkPortMedians {
  mainHandlerMs: number
  mainGenerationMs: number
  mainAllocationMs: number
  mainFillMs: number
  streamDispatchCopyMs: number
  streamDispatchPostMs: number
  rendererPcmAssemblyAllocationMs: number
  rendererPcmAssemblyCopyMs: number
  rendererPcmAssemblyMs: number
  rendererPortRequestMs: number
  streamChunkCount: number
  streamTailMs: number
  overlapTailResidualMs: number
}

export interface PcmTransferBenchmarkSizeSummary {
  sizeBytes: number
  sizeMiB: number
  repetitions: number
  main: PcmTransferBenchmarkMainMedians
  preload: PcmTransferBenchmarkPreloadMedians
  port: PcmTransferBenchmarkPortMedians
}

export interface PcmTransferBenchmarkSummary {
  benchmarkId: string
  startedAt: number
  completedAt: number
  warmupSizeBytes: number
  repetitions: number
  sizes: PcmTransferBenchmarkSizeSummary[]
}

export interface PcmTransferBenchmarkProgress {
  phase: 'warmup' | 'measuring' | 'logging'
  completedSteps: number
  totalSteps: number
  route?: PcmTransferBenchmarkRoute
  sizeBytes?: number
  repetition?: number
}

export interface PcmTransferBenchmarkDependencies {
  benchmarkMainPcmTransfer: (sizeBytes: number) => Promise<PcmTransferBenchmarkProbeResult>
  benchmarkPreloadPcmTransfer: (sizeBytes: number) => PcmTransferBenchmarkProbeResult
  benchmarkMainPortPcmTransfer: (sizeBytes: number) => Promise<MainPortPcmTransferBenchmarkProbeResult>
  logEvent: (
    payload: MemoryDiagnosticsEventPayload,
    options?: { captureSample?: boolean }
  ) => Promise<boolean>
}

export interface PcmTransferBenchmarkRunOptions {
  benchmarkId?: string
  sizesBytes?: readonly number[]
  repetitions?: number
  warmupSizeBytes?: number
  monotonicNow?: () => number
  wallNow?: () => number
  onProgress?: (progress: PcmTransferBenchmarkProgress) => void
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

function requireNonNegativeTiming(value: number | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`PCM transfer benchmark returned an invalid ${name}.`)
  }
  return value
}

function requireValidProbe(
  probe: PcmTransferBenchmarkProbeResult,
  expectedSizeBytes: number
): void {
  if (!validatePcmTransferBenchmarkProbe(probe, expectedSizeBytes)) {
    throw new Error('PCM transfer benchmark payload failed renderer validation.')
  }
  requireNonNegativeTiming(probe.allocationMs, 'allocation duration')
  requireNonNegativeTiming(probe.fillMs, 'fill duration')
}

function requireNonNegativeInteger(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`PCM transfer benchmark returned an invalid ${name}.`)
  }
  return value as number
}

interface PcmPortBenchmarkMainTimings {
  benchmarkMainGenerationMs?: number
  benchmarkMainFillMs?: number
}

function validatePortBenchmarkPayload(
  result: LocalPcmStreamDecodeResult,
  expectedSizeBytes: number
): void {
  if (
    result.pcmByteLength !== expectedSizeBytes
    || result.interleavedPcm.byteLength !== expectedSizeBytes
  ) {
    throw new Error('PCM port-stream benchmark returned an unexpected payload length.')
  }
  const bytes = new Uint8Array(result.interleavedPcm)
  const sentinels = [
    [0, PCM_TRANSFER_BENCHMARK_SENTINELS.first],
    [Math.floor(expectedSizeBytes / 2), PCM_TRANSFER_BENCHMARK_SENTINELS.middle],
    [expectedSizeBytes - 1, PCM_TRANSFER_BENCHMARK_SENTINELS.last]
  ] as const
  for (const [offset, expected] of sentinels) {
    if (bytes[offset] !== expected) {
      throw new Error('PCM port-stream benchmark payload failed renderer sentinel validation.')
    }
  }
}

/**
 * Adapts the production MessagePort PCM client to the diagnostics-only benchmark
 * endpoint. The endpoint recognizes the encoded size in preload; no audio file is
 * opened and no playback state is touched.
 */
export function createMainPortPcmTransferBenchmarkProbe(
  client: LocalPcmStreamClient
): (sizeBytes: number) => Promise<MainPortPcmTransferBenchmarkProbeResult> {
  let nextRequestId = 1
  return async (sizeValue: number): Promise<MainPortPcmTransferBenchmarkProbeResult> => {
    const sizeBytes = normalizePcmTransferBenchmarkSize(sizeValue)
    if (sizeBytes % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new RangeError('PCM port-stream benchmark size must be Float32-aligned.')
    }
    const requestId = nextRequestId
    nextRequestId += 1
    let result: LocalPcmStreamDecodeResult | null = await client.decode({
      requestId,
      filePath: `pcm-transfer-benchmark:${sizeBytes}`,
      outputSampleRate: 48_000,
      expectedChannels: 1,
      priority: 'interactive'
    })

    try {
      validatePortBenchmarkPayload(result, sizeBytes)
      const timings = result.transportTimings as typeof result.transportTimings
        & PcmPortBenchmarkMainTimings
      const mainHandlerMs = requireNonNegativeTiming(timings.mainHandlerMs, 'port main handler duration')
      const rendererPcmAssemblyAllocationMs = requireNonNegativeTiming(
        timings.rendererPcmAssemblyAllocationMs,
        'renderer PCM assembly allocation duration'
      )
      const rendererPcmAssemblyCopyMs = requireNonNegativeTiming(
        timings.rendererPcmAssemblyCopyMs,
        'renderer PCM assembly copy duration'
      )
      const rendererPortRequestMs = requireNonNegativeTiming(
        timings.rendererPortRequestMs,
        'renderer port request duration'
      )
      return {
        sizeBytes,
        payloadByteLength: result.interleavedPcm.byteLength,
        payloadValid: true,
        mainHandlerMs,
        mainGenerationMs: requireNonNegativeTiming(
          timings.benchmarkMainGenerationMs,
          'port main generation duration'
        ),
        mainAllocationMs: requireNonNegativeTiming(
          timings.allocationMs,
          'port main allocation duration'
        ),
        mainFillMs: requireNonNegativeTiming(timings.benchmarkMainFillMs, 'port main fill duration'),
        streamDispatchCopyMs: requireNonNegativeTiming(
          timings.streamDispatchCopyMs,
          'port dispatch copy duration'
        ),
        streamDispatchPostMs: requireNonNegativeTiming(
          timings.streamDispatchPostMs,
          'port dispatch post duration'
        ),
        rendererPcmAssemblyAllocationMs,
        rendererPcmAssemblyCopyMs,
        rendererPcmAssemblyMs: roundMs(
          rendererPcmAssemblyAllocationMs + rendererPcmAssemblyCopyMs
        ),
        rendererPortRequestMs,
        streamChunkCount: requireNonNegativeInteger(timings.streamChunkCount, 'port chunk count'),
        streamTailMs: requireNonNegativeTiming(timings.streamTailMs, 'port stream tail duration'),
        overlapTailResidualMs: calculatePcmTransferResidualMs(rendererPortRequestMs, mainHandlerMs)
      }
    } finally {
      // Drop the large backing store before the next sequential trial. The
      // benchmark retains numeric metrics only.
      result.interleavedPcm = new ArrayBuffer(0)
      result = null
    }
  }
}

export function calculatePcmTransferResidualMs(
  encompassingDurationMs: number,
  innerDurationMs: number
): number {
  const encompassing = requireNonNegativeTiming(encompassingDurationMs, 'encompassing duration')
  const inner = requireNonNegativeTiming(innerDurationMs, 'inner duration')
  return roundMs(Math.max(0, encompassing - inner))
}

export function medianPcmTransferMetric(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot calculate a PCM transfer benchmark median without samples.')
  }
  const sorted = values.map((value) => requireNonNegativeTiming(value, 'sample duration')).sort((a, b) => a - b)
  const midpoint = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
  return roundMs(value)
}

function requireValidPortProbe(
  probe: MainPortPcmTransferBenchmarkProbeResult,
  expectedSizeBytes: number
): void {
  if (
    probe.sizeBytes !== expectedSizeBytes
    || probe.payloadByteLength !== expectedSizeBytes
    || probe.payloadValid !== true
  ) {
    throw new Error('PCM port-stream benchmark payload failed renderer validation.')
  }
  requireNonNegativeTiming(probe.mainHandlerMs, 'port main handler duration')
  requireNonNegativeTiming(probe.mainGenerationMs, 'port main generation duration')
  requireNonNegativeTiming(probe.mainAllocationMs, 'port main allocation duration')
  requireNonNegativeTiming(probe.mainFillMs, 'port main fill duration')
  requireNonNegativeTiming(probe.streamDispatchCopyMs, 'port dispatch copy duration')
  requireNonNegativeTiming(probe.streamDispatchPostMs, 'port dispatch post duration')
  requireNonNegativeTiming(
    probe.rendererPcmAssemblyAllocationMs,
    'renderer PCM assembly allocation duration'
  )
  requireNonNegativeTiming(probe.rendererPcmAssemblyCopyMs, 'renderer PCM assembly copy duration')
  requireNonNegativeTiming(probe.rendererPcmAssemblyMs, 'renderer PCM assembly duration')
  requireNonNegativeTiming(probe.rendererPortRequestMs, 'renderer port request duration')
  requireNonNegativeInteger(probe.streamChunkCount, 'port chunk count')
  requireNonNegativeTiming(probe.streamTailMs, 'port stream tail duration')
  requireNonNegativeTiming(probe.overlapTailResidualMs, 'port overlap/tail residual')
}

export function createPcmTransferBenchmarkPlan(
  sizesBytes: readonly number[] = PCM_TRANSFER_BENCHMARK_SIZES_BYTES,
  repetitions: number = PCM_TRANSFER_BENCHMARK_REPETITIONS,
  warmupSizeBytes: number = PCM_TRANSFER_BENCHMARK_WARMUP_SIZE_BYTES
): PcmTransferBenchmarkPlanStep[] {
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    throw new RangeError('PCM transfer benchmark repetitions must be a positive integer.')
  }
  if (sizesBytes.length === 0) {
    throw new RangeError('PCM transfer benchmark requires at least one payload size.')
  }

  const normalizedWarmupSizeBytes = normalizePcmTransferBenchmarkSize(warmupSizeBytes)
  const normalizedSizes = sizesBytes.map((sizeBytes) => normalizePcmTransferBenchmarkSize(sizeBytes))
  const steps: PcmTransferBenchmarkPlanStep[] = [
    {
      route: 'main-ipc-bridge',
      sizeBytes: normalizedWarmupSizeBytes,
      repetition: null,
      warmup: true
    },
    {
      route: 'preload-bridge-only',
      sizeBytes: normalizedWarmupSizeBytes,
      repetition: null,
      warmup: true
    },
    {
      route: 'main-port-stream',
      sizeBytes: normalizedWarmupSizeBytes,
      repetition: null,
      warmup: true
    }
  ]

  for (const sizeBytes of normalizedSizes) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      steps.push({
        route: 'main-ipc-bridge',
        sizeBytes,
        repetition,
        warmup: false
      })
      steps.push({
        route: 'preload-bridge-only',
        sizeBytes,
        repetition,
        warmup: false
      })
      steps.push({
        route: 'main-port-stream',
        sizeBytes,
        repetition,
        warmup: false
      })
    }
  }

  return steps
}

function summarizeSamples(
  samples: readonly PcmTransferBenchmarkSample[],
  sizesBytes: readonly number[],
  repetitions: number
): PcmTransferBenchmarkSizeSummary[] {
  return sizesBytes.map((sizeBytes) => {
    const main = samples.filter((sample): sample is MainPcmTransferBenchmarkSample => (
      sample.route === 'main-ipc-bridge' && sample.sizeBytes === sizeBytes
    ))
    const preload = samples.filter((sample): sample is PreloadPcmTransferBenchmarkSample => (
      sample.route === 'preload-bridge-only' && sample.sizeBytes === sizeBytes
    ))
    const port = samples.filter((sample): sample is MainPortPcmTransferBenchmarkSample => (
      sample.route === 'main-port-stream' && sample.sizeBytes === sizeBytes
    ))
    if (main.length !== repetitions || preload.length !== repetitions || port.length !== repetitions) {
      throw new Error(`PCM transfer benchmark did not collect every ${sizeBytes}-byte sample.`)
    }

    return {
      sizeBytes,
      sizeMiB: sizeBytes / MEBIBYTE,
      repetitions,
      main: {
        allocationMs: medianPcmTransferMetric(main.map((sample) => sample.allocationMs)),
        fillMs: medianPcmTransferMetric(main.map((sample) => sample.fillMs)),
        mainHandlerMs: medianPcmTransferMetric(main.map((sample) => sample.mainHandlerMs)),
        preloadInvokeMs: medianPcmTransferMetric(main.map((sample) => sample.preloadInvokeMs)),
        rendererBridgeCallMs: medianPcmTransferMetric(main.map((sample) => sample.rendererBridgeCallMs)),
        electronIpcResidualMs: medianPcmTransferMetric(main.map((sample) => sample.electronIpcResidualMs)),
        contextBridgeResidualMs: medianPcmTransferMetric(main.map((sample) => sample.contextBridgeResidualMs))
      },
      preload: {
        allocationMs: medianPcmTransferMetric(preload.map((sample) => sample.allocationMs)),
        fillMs: medianPcmTransferMetric(preload.map((sample) => sample.fillMs)),
        preloadServiceMs: medianPcmTransferMetric(preload.map((sample) => sample.preloadServiceMs)),
        rendererBridgeCallMs: medianPcmTransferMetric(preload.map((sample) => sample.rendererBridgeCallMs)),
        contextBridgeResidualMs: medianPcmTransferMetric(preload.map((sample) => sample.contextBridgeResidualMs))
      },
      port: {
        mainHandlerMs: medianPcmTransferMetric(port.map((sample) => sample.mainHandlerMs)),
        mainGenerationMs: medianPcmTransferMetric(port.map((sample) => sample.mainGenerationMs)),
        mainAllocationMs: medianPcmTransferMetric(port.map((sample) => sample.mainAllocationMs)),
        mainFillMs: medianPcmTransferMetric(port.map((sample) => sample.mainFillMs)),
        streamDispatchCopyMs: medianPcmTransferMetric(port.map((sample) => sample.streamDispatchCopyMs)),
        streamDispatchPostMs: medianPcmTransferMetric(port.map((sample) => sample.streamDispatchPostMs)),
        rendererPcmAssemblyAllocationMs: medianPcmTransferMetric(
          port.map((sample) => sample.rendererPcmAssemblyAllocationMs)
        ),
        rendererPcmAssemblyCopyMs: medianPcmTransferMetric(
          port.map((sample) => sample.rendererPcmAssemblyCopyMs)
        ),
        rendererPcmAssemblyMs: medianPcmTransferMetric(port.map((sample) => sample.rendererPcmAssemblyMs)),
        rendererPortRequestMs: medianPcmTransferMetric(port.map((sample) => sample.rendererPortRequestMs)),
        streamChunkCount: medianPcmTransferMetric(port.map((sample) => sample.streamChunkCount)),
        streamTailMs: medianPcmTransferMetric(port.map((sample) => sample.streamTailMs)),
        overlapTailResidualMs: medianPcmTransferMetric(port.map((sample) => sample.overlapTailResidualMs))
      }
    }
  })
}

function createBenchmarkId(now: number): string {
  const randomSuffix = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `pcm-transfer-${now}-${randomSuffix}`
}

function sampleDetails(sample: PcmTransferBenchmarkSample): Record<string, unknown> {
  return { ...sample }
}

export async function runPcmTransferBenchmark(
  dependencies: PcmTransferBenchmarkDependencies,
  options: PcmTransferBenchmarkRunOptions = {}
): Promise<PcmTransferBenchmarkSummary> {
  const sizesBytes = (options.sizesBytes ?? PCM_TRANSFER_BENCHMARK_SIZES_BYTES)
    .map((sizeBytes) => normalizePcmTransferBenchmarkSize(sizeBytes))
  const repetitions = options.repetitions ?? PCM_TRANSFER_BENCHMARK_REPETITIONS
  const warmupSizeBytes = normalizePcmTransferBenchmarkSize(
    options.warmupSizeBytes ?? PCM_TRANSFER_BENCHMARK_WARMUP_SIZE_BYTES
  )
  const plan = createPcmTransferBenchmarkPlan(sizesBytes, repetitions, warmupSizeBytes)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const wallNow = options.wallNow ?? (() => Date.now())
  const startedAt = wallNow()
  const benchmarkId = options.benchmarkId ?? createBenchmarkId(startedAt)
  const samples: PcmTransferBenchmarkSample[] = []

  let completedSteps = 0
  for (const step of plan) {
    options.onProgress?.({
      phase: step.warmup ? 'warmup' : 'measuring',
      completedSteps,
      totalSteps: plan.length,
      route: step.route,
      sizeBytes: step.sizeBytes,
      repetition: step.repetition ?? undefined
    })

    if (step.warmup) {
      if (step.route === 'main-port-stream') {
        let warmupProbe: MainPortPcmTransferBenchmarkProbeResult | null =
          await dependencies.benchmarkMainPortPcmTransfer(step.sizeBytes)
        requireValidPortProbe(warmupProbe, step.sizeBytes)
        warmupProbe = null
      } else {
        let warmupProbe: PcmTransferBenchmarkProbeResult | null = step.route === 'main-ipc-bridge'
          ? await dependencies.benchmarkMainPcmTransfer(step.sizeBytes)
          : dependencies.benchmarkPreloadPcmTransfer(step.sizeBytes)
        requireValidProbe(warmupProbe, step.sizeBytes)
        warmupProbe = null
      }
      completedSteps += 1
      continue
    }

    if (step.route === 'main-port-stream') {
      let probe: MainPortPcmTransferBenchmarkProbeResult | null =
        await dependencies.benchmarkMainPortPcmTransfer(step.sizeBytes)
      requireValidPortProbe(probe, step.sizeBytes)
      samples.push({
        benchmarkId,
        route: step.route,
        sizeBytes: step.sizeBytes,
        sizeMiB: step.sizeBytes / MEBIBYTE,
        repetition: step.repetition as number,
        payloadByteLength: probe.payloadByteLength,
        payloadValid: true,
        mainHandlerMs: probe.mainHandlerMs,
        mainGenerationMs: probe.mainGenerationMs,
        mainAllocationMs: probe.mainAllocationMs,
        mainFillMs: probe.mainFillMs,
        streamDispatchCopyMs: probe.streamDispatchCopyMs,
        streamDispatchPostMs: probe.streamDispatchPostMs,
        rendererPcmAssemblyAllocationMs: probe.rendererPcmAssemblyAllocationMs,
        rendererPcmAssemblyCopyMs: probe.rendererPcmAssemblyCopyMs,
        rendererPcmAssemblyMs: probe.rendererPcmAssemblyMs,
        rendererPortRequestMs: probe.rendererPortRequestMs,
        streamChunkCount: probe.streamChunkCount,
        streamTailMs: probe.streamTailMs,
        overlapTailResidualMs: probe.overlapTailResidualMs
      })
      probe = null
      completedSteps += 1
      continue
    }

    const callStartedAt = monotonicNow()
    let probe: PcmTransferBenchmarkProbeResult | null = step.route === 'main-ipc-bridge'
      ? await dependencies.benchmarkMainPcmTransfer(step.sizeBytes)
      : dependencies.benchmarkPreloadPcmTransfer(step.sizeBytes)
    const rendererBridgeCallMs = roundMs(monotonicNow() - callStartedAt)
    requireValidProbe(probe, step.sizeBytes)

    const base = {
      benchmarkId,
      route: step.route,
      sizeBytes: step.sizeBytes,
      sizeMiB: step.sizeBytes / MEBIBYTE,
      repetition: step.repetition as number,
      payloadByteLength: probe.payload.byteLength,
      payloadValid: true as const,
      allocationMs: requireNonNegativeTiming(probe.allocationMs, 'allocation duration'),
      fillMs: requireNonNegativeTiming(probe.fillMs, 'fill duration'),
      rendererBridgeCallMs
    }

    if (step.route === 'main-ipc-bridge') {
      const mainHandlerMs = requireNonNegativeTiming(probe.mainHandlerMs, 'main handler duration')
      const preloadInvokeMs = requireNonNegativeTiming(probe.preloadInvokeMs, 'preload invoke duration')
      samples.push({
        ...base,
        route: step.route,
        mainHandlerMs,
        preloadInvokeMs,
        electronIpcResidualMs: calculatePcmTransferResidualMs(preloadInvokeMs, mainHandlerMs),
        contextBridgeResidualMs: calculatePcmTransferResidualMs(rendererBridgeCallMs, preloadInvokeMs)
      })
    } else {
      const preloadServiceMs = requireNonNegativeTiming(probe.preloadServiceMs, 'preload service duration')
      samples.push({
        ...base,
        route: step.route,
        preloadServiceMs,
        contextBridgeResidualMs: calculatePcmTransferResidualMs(rendererBridgeCallMs, preloadServiceMs)
      })
    }
    // Explicitly release the only renderer reference to the returned payload
    // before starting the next trial. Only numeric sample metrics are retained.
    probe = null
    completedSteps += 1
  }

  options.onProgress?.({
    phase: 'logging',
    completedSteps: plan.length,
    totalSteps: plan.length
  })

  const completedAt = wallNow()
  const summary: PcmTransferBenchmarkSummary = {
    benchmarkId,
    startedAt,
    completedAt,
    warmupSizeBytes,
    repetitions,
    sizes: summarizeSamples(samples, sizesBytes, repetitions)
  }

  // Logging is intentionally deferred until all transfer timings are captured.
  // Raw sample events never request memory snapshots; only the completion event does.
  for (const sample of samples) {
    const logged = await dependencies.logEvent({
      name: 'pcm_transfer_benchmark_sample',
      source: 'renderer',
      details: sampleDetails(sample)
    }, { captureSample: false })
    if (!logged) {
      throw new Error('Diagnostics logging stopped before PCM transfer benchmark samples were saved.')
    }
  }

  const completionLogged = await dependencies.logEvent({
    name: 'pcm_transfer_benchmark_completed',
    source: 'renderer',
    details: {
      ...summary,
      residualInterpretation: 'Residuals include scheduling and dispatch overhead and do not prove a memcpy count. Port overlap/tail residual is renderer request wall time minus main handler wall time, clamped to zero.'
    }
  }, { captureSample: true })
  if (!completionLogged) {
    throw new Error('Diagnostics logging stopped before the PCM transfer benchmark summary was saved.')
  }

  return summary
}
