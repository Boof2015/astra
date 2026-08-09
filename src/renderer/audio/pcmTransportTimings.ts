export interface PcmTransportTimings {
  decodeRequestId: number
  validPcmBytes: number
  backingBufferBytes: number
  allocationGrowthCount: number
  transportRoute?: 'invoke' | 'message_port_stream'
  /** Main-process handler wall span; decoder subphases may overlap within it. */
  mainHandlerMs: number
  binaryResolutionMs: number
  probeMs: number
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  probeDecodeOverlapEnabled?: boolean
  /** Wall time during which probing and FFmpeg decoding overlapped. */
  probeFfmpegOverlapMs?: number
  ffmpegMs: number
  ffmpegSpawnToFirstPcmMs?: number
  ffmpegPcmOutputSpanMs?: number
  ffmpegCloseTailMs?: number
  allocationMs: number
  initialAllocationMs?: number
  growthAllocationMs?: number
  payloadFinalizationMs: number
  preloadInvokeMs: number
  streamChunkCount?: number
  streamDispatchCopyMs?: number
  streamDispatchPostMs?: number
  streamTailMs?: number
  rendererPcmAssemblyAllocationMs?: number
  rendererPcmAssemblyCopyMs?: number
  rendererPortRequestMs?: number
}

export interface PcmTransportTimingSummary {
  decodeRequestId?: number
  validPcmBytes?: number
  backingBufferBytes?: number
  allocationGrowthCount?: number
  transportRoute?: 'invoke' | 'message_port_stream'
  mainHandlerMs?: number
  binaryResolutionMs?: number
  probeMs?: number
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  probeDecodeOverlapEnabled?: boolean
  probeFfmpegOverlapMs?: number
  ffmpegMs?: number
  ffmpegSpawnToFirstPcmMs?: number
  ffmpegPcmOutputSpanMs?: number
  ffmpegCloseTailMs?: number
  pcmAllocationMs?: number
  initialPcmAllocationMs?: number
  growthPcmAllocationMs?: number
  payloadFinalizationMs?: number
  preloadInvokeMs?: number
  rendererBridgeCallMs: number
  electronIpcResidualMs?: number
  contextBridgeResidualMs?: number
  streamChunkCount?: number
  streamDispatchCopyMs?: number
  streamDispatchPostMs?: number
  streamTailMs?: number
  rendererPcmAssemblyAllocationMs?: number
  rendererPcmAssemblyCopyMs?: number
  rendererPortRequestMs?: number
  streamTransportResidualMs?: number
}

export function clampDiagnosticDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  return Math.max(0, value)
}

/**
 * Builds renderer-visible transport timings from durations measured in their
 * owning processes. The residuals include Electron scheduling/dispatch and
 * serialization overhead; they are diagnostics and do not establish a memcpy
 * count or attribute all elapsed time to copying.
 */
export function summarizePcmTransportTimings(
  transportTimings: PcmTransportTimings | null | undefined,
  rendererBridgeCallMsValue: unknown,
): PcmTransportTimingSummary {
  const rendererBridgeCallMs = clampDiagnosticDurationMs(rendererBridgeCallMsValue) ?? 0
  if (!transportTimings) return { rendererBridgeCallMs }

  const mainHandlerMs = clampDiagnosticDurationMs(transportTimings.mainHandlerMs)
  const preloadInvokeMs = clampDiagnosticDurationMs(transportTimings.preloadInvokeMs)
  const decodeRequestId = nonNegativeSafeInteger(transportTimings.decodeRequestId)
  const validPcmBytes = nonNegativeSafeInteger(transportTimings.validPcmBytes)
  const backingBufferBytes = nonNegativeSafeInteger(transportTimings.backingBufferBytes)
  const allocationGrowthCount = nonNegativeSafeInteger(transportTimings.allocationGrowthCount)
  const transportRoute = transportTimings.transportRoute === 'message_port_stream'
    ? 'message_port_stream'
    : 'invoke'
  const binaryResolutionMs = clampDiagnosticDurationMs(transportTimings.binaryResolutionMs)
  const probeMs = clampDiagnosticDurationMs(transportTimings.probeMs)
  const probeCacheStatus = transportTimings.probeCacheStatus === 'hit'
    || transportTimings.probeCacheStatus === 'miss'
    || transportTimings.probeCacheStatus === 'bypass'
    ? transportTimings.probeCacheStatus
    : undefined
  const probeDecodeOverlapEnabled = typeof transportTimings.probeDecodeOverlapEnabled === 'boolean'
    ? transportTimings.probeDecodeOverlapEnabled
    : undefined
  const probeFfmpegOverlapMs = clampDiagnosticDurationMs(transportTimings.probeFfmpegOverlapMs)
  const ffmpegMs = clampDiagnosticDurationMs(transportTimings.ffmpegMs)
  const ffmpegSpawnToFirstPcmMs = clampDiagnosticDurationMs(
    transportTimings.ffmpegSpawnToFirstPcmMs
  )
  const ffmpegPcmOutputSpanMs = clampDiagnosticDurationMs(transportTimings.ffmpegPcmOutputSpanMs)
  const ffmpegCloseTailMs = clampDiagnosticDurationMs(transportTimings.ffmpegCloseTailMs)
  const pcmAllocationMs = clampDiagnosticDurationMs(transportTimings.allocationMs)
  const initialPcmAllocationMs = clampDiagnosticDurationMs(transportTimings.initialAllocationMs)
  const growthPcmAllocationMs = clampDiagnosticDurationMs(transportTimings.growthAllocationMs)
  const payloadFinalizationMs = clampDiagnosticDurationMs(transportTimings.payloadFinalizationMs)
  const streamChunkCount = nonNegativeSafeInteger(transportTimings.streamChunkCount)
  const streamDispatchCopyMs = clampDiagnosticDurationMs(transportTimings.streamDispatchCopyMs)
  const streamDispatchPostMs = clampDiagnosticDurationMs(transportTimings.streamDispatchPostMs)
  const streamTailMs = clampDiagnosticDurationMs(transportTimings.streamTailMs)
  const rendererPcmAssemblyAllocationMs = clampDiagnosticDurationMs(
    transportTimings.rendererPcmAssemblyAllocationMs
  )
  const rendererPcmAssemblyCopyMs = clampDiagnosticDurationMs(
    transportTimings.rendererPcmAssemblyCopyMs
  )
  const rendererPortRequestMs = clampDiagnosticDurationMs(transportTimings.rendererPortRequestMs)

  return {
    rendererBridgeCallMs,
    transportRoute,
    ...(decodeRequestId === undefined ? {} : { decodeRequestId }),
    ...(validPcmBytes === undefined ? {} : { validPcmBytes }),
    ...(backingBufferBytes === undefined ? {} : { backingBufferBytes }),
    ...(allocationGrowthCount === undefined ? {} : { allocationGrowthCount }),
    ...(mainHandlerMs === undefined ? {} : { mainHandlerMs }),
    ...(binaryResolutionMs === undefined ? {} : { binaryResolutionMs }),
    ...(probeMs === undefined ? {} : { probeMs }),
    ...(probeCacheStatus === undefined ? {} : { probeCacheStatus }),
    ...(probeDecodeOverlapEnabled === undefined ? {} : { probeDecodeOverlapEnabled }),
    ...(probeFfmpegOverlapMs === undefined ? {} : { probeFfmpegOverlapMs }),
    ...(ffmpegMs === undefined ? {} : { ffmpegMs }),
    ...(ffmpegSpawnToFirstPcmMs === undefined ? {} : { ffmpegSpawnToFirstPcmMs }),
    ...(ffmpegPcmOutputSpanMs === undefined ? {} : { ffmpegPcmOutputSpanMs }),
    ...(ffmpegCloseTailMs === undefined ? {} : { ffmpegCloseTailMs }),
    ...(pcmAllocationMs === undefined ? {} : { pcmAllocationMs }),
    ...(initialPcmAllocationMs === undefined ? {} : { initialPcmAllocationMs }),
    ...(growthPcmAllocationMs === undefined ? {} : { growthPcmAllocationMs }),
    ...(payloadFinalizationMs === undefined ? {} : { payloadFinalizationMs }),
    ...(transportRoute !== 'invoke' || preloadInvokeMs === undefined ? {} : { preloadInvokeMs }),
    ...(transportRoute !== 'invoke' || mainHandlerMs === undefined || preloadInvokeMs === undefined
      ? {}
      : { electronIpcResidualMs: Math.max(0, preloadInvokeMs - mainHandlerMs) }),
    ...(transportRoute !== 'invoke' || preloadInvokeMs === undefined
      ? {}
      : { contextBridgeResidualMs: Math.max(0, rendererBridgeCallMs - preloadInvokeMs) }),
    ...(streamChunkCount === undefined ? {} : { streamChunkCount }),
    ...(streamDispatchCopyMs === undefined ? {} : { streamDispatchCopyMs }),
    ...(streamDispatchPostMs === undefined ? {} : { streamDispatchPostMs }),
    ...(streamTailMs === undefined ? {} : { streamTailMs }),
    ...(rendererPcmAssemblyAllocationMs === undefined ? {} : { rendererPcmAssemblyAllocationMs }),
    ...(rendererPcmAssemblyCopyMs === undefined ? {} : { rendererPcmAssemblyCopyMs }),
    ...(rendererPortRequestMs === undefined ? {} : { rendererPortRequestMs }),
    ...(transportRoute !== 'message_port_stream' || mainHandlerMs === undefined
      ? {}
      : {
          streamTransportResidualMs: Math.max(
            0,
            (rendererPortRequestMs ?? rendererBridgeCallMs) - mainHandlerMs
          )
        }),
  }
}

export function sumDiagnosticDurations(...values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => {
    return total + (clampDiagnosticDurationMs(value) ?? 0)
  }, 0)
}
