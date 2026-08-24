import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MAX_CREDITS,
  LOCAL_PCM_STREAM_VERSION,
  isLocalPcmStreamRendererMessage,
  type LocalPcmStreamCompleteMessage,
  type LocalPcmStreamMainMessage,
  type LocalPcmStreamMainTransportTimings
} from '../shared/localPcmStream'
import {
  fillPcmTransferBenchmarkChunk,
  type PcmTransferBenchmarkStreamOpenRequest
} from '../shared/pcmTransferBenchmark'

export const PCM_TRANSFER_BENCHMARK_STREAM_SAMPLE_RATE = 48_000
export const PCM_TRANSFER_BENCHMARK_STREAM_CHANNELS = 1
export const PCM_TRANSFER_BENCHMARK_STREAM_TIMEOUT_MS = 30_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface PcmTransferBenchmarkStreamPort {
  postMessage(message: LocalPcmStreamMainMessage): void
  start(): void
  close(): void
  subscribe(
    onMessage: (data: unknown) => void,
    onClose: () => void
  ): () => void
}

export interface PcmTransferBenchmarkStreamRuntime {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  timeoutMs?: number
}

interface ActiveBenchmarkStream {
  request: PcmTransferBenchmarkStreamOpenRequest
  port: PcmTransferBenchmarkStreamPort
  handlerStartedAtMs: number
  ready: boolean
  credits: number
  nextChunkOffset: number
  nextChunkSequence: number
  nextCreditSequence: number
  chunkCount: number
  allocationMs: number
  fillMs: number
  generationMs: number
  dispatchCopyMs: number
  dispatchPostMs: number
  finalChunkPostedAtMs: number | null
  pumping: boolean
  settled: boolean
  timeout: TimerHandle | null
  releasePortHooks: (() => void) | null
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

function benchmarkMessageBase(request: PcmTransferBenchmarkStreamOpenRequest): {
  version: typeof LOCAL_PCM_STREAM_VERSION
  requestId: number
  nonce: string
} {
  return {
    version: LOCAL_PCM_STREAM_VERSION,
    requestId: request.requestId,
    nonce: request.nonce
  }
}

/**
 * Owns at most one diagnostics benchmark stream at a time. Each generated
 * source chunk and its standalone dispatch copy fall out of scope immediately
 * after postMessage; this class never retains a full synthetic payload.
 */
export class PcmTransferBenchmarkStreamCoordinator {
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly timeoutMs: number
  private active: ActiveBenchmarkStream | null = null

  constructor(runtime: PcmTransferBenchmarkStreamRuntime = {}) {
    this.now = runtime.now ?? (() => performance.now())
    this.setTimer = runtime.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = runtime.clearTimer ?? ((handle) => clearTimeout(handle))
    this.timeoutMs = runtime.timeoutMs ?? PCM_TRANSFER_BENCHMARK_STREAM_TIMEOUT_MS
  }

  get busy(): boolean {
    return this.active !== null
  }

  start(
    port: PcmTransferBenchmarkStreamPort,
    request: PcmTransferBenchmarkStreamOpenRequest,
    handlerStartedAtMs: number = this.now()
  ): boolean {
    if (this.active) {
      this.rejectAndClose(
        port,
        request,
        'PCM_BENCHMARK_STREAM_BUSY',
        'Another PCM transfer benchmark stream is already running.'
      )
      return false
    }

    const stream: ActiveBenchmarkStream = {
      request,
      port,
      handlerStartedAtMs,
      ready: false,
      credits: 0,
      nextChunkOffset: 0,
      nextChunkSequence: 0,
      nextCreditSequence: 0,
      chunkCount: 0,
      allocationMs: 0,
      fillMs: 0,
      generationMs: 0,
      dispatchCopyMs: 0,
      dispatchPostMs: 0,
      finalChunkPostedAtMs: null,
      pumping: false,
      settled: false,
      timeout: null,
      releasePortHooks: null
    }
    this.active = stream

    try {
      stream.releasePortHooks = port.subscribe(
        (data) => this.handleMessage(stream, data),
        () => this.cleanup(stream)
      )
      this.post(stream, {
        type: 'accepted',
        ...benchmarkMessageBase(request)
      })
      if (stream.settled) return false
      // MessagePortMain queues renderer controls until start(). Publish the
      // handshake first so a queued ready cannot make start/chunks overtake it.
      port.start()
      if (stream.settled) return false
      stream.timeout = this.setTimer(() => {
        this.fail(
          stream,
          'PCM_BENCHMARK_STREAM_TIMEOUT',
          'PCM transfer benchmark stream timed out.'
        )
      }, this.timeoutMs)
      const timeoutWithUnref = stream.timeout as { unref?: () => void }
      timeoutWithUnref.unref?.()
      return !stream.settled
    } catch {
      this.cleanup(stream)
      return false
    }
  }

  private handleMessage(stream: ActiveBenchmarkStream, data: unknown): void {
    if (stream.settled || this.active !== stream) return
    if (
      !isLocalPcmStreamRendererMessage(data)
      || data.requestId !== stream.request.requestId
      || data.nonce !== stream.request.nonce
    ) {
      this.fail(
        stream,
        'PCM_BENCHMARK_STREAM_PROTOCOL_ERROR',
        'PCM transfer benchmark stream received invalid control data.'
      )
      return
    }

    if (data.type === 'ready') {
      if (stream.ready || data.credits !== LOCAL_PCM_STREAM_INITIAL_CREDITS) {
        this.fail(
          stream,
          'PCM_BENCHMARK_STREAM_PROTOCOL_ERROR',
          'PCM transfer benchmark stream received invalid initial credits.'
        )
        return
      }
      stream.ready = true
      stream.credits = LOCAL_PCM_STREAM_INITIAL_CREDITS
      try {
        this.post(stream, {
          type: 'start',
          ...benchmarkMessageBase(stream.request),
          sampleRate: PCM_TRANSFER_BENCHMARK_STREAM_SAMPLE_RATE,
          channels: PCM_TRANSFER_BENCHMARK_STREAM_CHANNELS,
          backingBufferBytes: stream.request.sizeBytes
        })
      } catch {
        this.cleanup(stream)
        return
      }
      this.pump(stream)
      return
    }

    if (data.type === 'credit') {
      if (
        !stream.ready
        || data.sequence !== stream.nextCreditSequence
        || stream.nextCreditSequence >= stream.nextChunkSequence
        || stream.credits >= LOCAL_PCM_STREAM_MAX_CREDITS
      ) {
        this.fail(
          stream,
          'PCM_BENCHMARK_STREAM_PROTOCOL_ERROR',
          'PCM transfer benchmark stream received an invalid or duplicate credit.'
        )
        return
      }
      stream.nextCreditSequence += 1
      stream.credits += 1
      this.pump(stream)
      this.completeIfAcknowledged(stream)
      return
    }

    this.cancel(stream)
  }

  private pump(stream: ActiveBenchmarkStream): void {
    if (
      stream.settled
      || !stream.ready
      || stream.pumping
      || this.active !== stream
    ) return

    stream.pumping = true
    try {
      while (
        !stream.settled
        && stream.credits > 0
        && stream.nextChunkOffset < stream.request.sizeBytes
      ) {
        const byteOffset = stream.nextChunkOffset
        const byteLength = Math.min(
          LOCAL_PCM_STREAM_CHUNK_BYTES,
          stream.request.sizeBytes - byteOffset
        )

        const generationStartedAtMs = this.now()
        const allocationStartedAtMs = this.now()
        const source = Buffer.allocUnsafe(byteLength)
        stream.allocationMs += this.now() - allocationStartedAtMs
        const fillStartedAtMs = this.now()
        fillPcmTransferBenchmarkChunk(source, byteOffset, stream.request.sizeBytes)
        stream.fillMs += this.now() - fillStartedAtMs
        stream.generationMs += this.now() - generationStartedAtMs

        const copyStartedAtMs = this.now()
        const payload = source.buffer.slice(
          source.byteOffset,
          source.byteOffset + source.byteLength
        ) as ArrayBuffer
        stream.dispatchCopyMs += this.now() - copyStartedAtMs

        const sequence = stream.nextChunkSequence
        stream.credits -= 1
        stream.nextChunkOffset += byteLength
        stream.nextChunkSequence += 1
        stream.chunkCount += 1

        const postStartedAtMs = this.now()
        if (stream.nextChunkOffset === stream.request.sizeBytes) {
          stream.finalChunkPostedAtMs = postStartedAtMs
        }
        this.post(stream, {
          type: 'chunk',
          ...benchmarkMessageBase(stream.request),
          sequence,
          byteOffset,
          byteLength,
          payload
        })
        stream.dispatchPostMs += this.now() - postStartedAtMs
      }
    } catch {
      this.fail(
        stream,
        'PCM_BENCHMARK_STREAM_DISPATCH_FAILED',
        'PCM transfer benchmark stream could not dispatch its synthetic payload.'
      )
    } finally {
      stream.pumping = false
    }
  }

  private completeIfAcknowledged(stream: ActiveBenchmarkStream): void {
    if (
      stream.settled
      || stream.nextChunkOffset !== stream.request.sizeBytes
      || stream.nextCreditSequence !== stream.chunkCount
    ) return

    const finalizationStartedAtMs = this.now()
    const streamTailMs = stream.finalChunkPostedAtMs === null
      ? 0
      : this.now() - stream.finalChunkPostedAtMs
    const transportTimings: LocalPcmStreamMainTransportTimings = {
      decodeRequestId: stream.request.requestId,
      validPcmBytes: stream.request.sizeBytes,
      backingBufferBytes: stream.request.sizeBytes,
      allocationGrowthCount: 0,
      transportRoute: 'message_port_stream',
      mainHandlerMs: 0,
      binaryResolutionMs: 0,
      probeMs: 0,
      ffmpegMs: 0,
      allocationMs: roundMs(stream.allocationMs),
      initialAllocationMs: roundMs(stream.allocationMs),
      growthAllocationMs: 0,
      payloadFinalizationMs: 0,
      preloadInvokeMs: 0,
      streamChunkCount: stream.chunkCount,
      streamDispatchCopyMs: roundMs(stream.dispatchCopyMs),
      streamDispatchPostMs: roundMs(stream.dispatchPostMs),
      streamTailMs: roundMs(streamTailMs),
      benchmarkMainGenerationMs: roundMs(stream.generationMs),
      benchmarkMainFillMs: roundMs(stream.fillMs)
    }
    const message: LocalPcmStreamCompleteMessage = {
      type: 'complete',
      ...benchmarkMessageBase(stream.request),
      frames: stream.request.sizeBytes / Float32Array.BYTES_PER_ELEMENT,
      pcmByteLength: stream.request.sizeBytes,
      probeMs: 0,
      decodeMs: 0,
      backgroundPriorityApplied: false,
      chunkCount: stream.chunkCount,
      transportTimings
    }
    transportTimings.payloadFinalizationMs = roundMs(this.now() - finalizationStartedAtMs)
    transportTimings.mainHandlerMs = roundMs(this.now() - stream.handlerStartedAtMs)

    try {
      this.post(stream, message)
    } catch {
      this.cleanup(stream)
      return
    }
    this.cleanup(stream)
  }

  private cancel(stream: ActiveBenchmarkStream): void {
    if (stream.settled) return
    try {
      this.post(stream, {
        type: 'cancelled',
        ...benchmarkMessageBase(stream.request)
      })
    } catch {
      // Closing the port is sufficient if its peer already disappeared.
    }
    this.cleanup(stream)
  }

  private fail(stream: ActiveBenchmarkStream, code: string, message: string): void {
    if (stream.settled) return
    try {
      this.post(stream, {
        type: 'error',
        ...benchmarkMessageBase(stream.request),
        kind: 'transport',
        code,
        message
      })
    } catch {
      // Closing the port still releases all stream state.
    }
    this.cleanup(stream)
  }

  private rejectAndClose(
    port: PcmTransferBenchmarkStreamPort,
    request: PcmTransferBenchmarkStreamOpenRequest,
    code: string,
    message: string
  ): void {
    try {
      port.postMessage({
        type: 'error',
        ...benchmarkMessageBase(request),
        kind: 'transport',
        code,
        message
      })
    } catch {
      // The peer may already have closed.
    }
    try {
      port.close()
    } catch {
      // Best-effort cleanup only.
    }
  }

  private post(stream: ActiveBenchmarkStream, message: LocalPcmStreamMainMessage): void {
    if (stream.settled) throw new Error('PCM transfer benchmark stream is already closed.')
    stream.port.postMessage(message)
  }

  private cleanup(stream: ActiveBenchmarkStream): void {
    if (stream.settled) return
    stream.settled = true
    if (this.active === stream) this.active = null
    if (stream.timeout !== null) {
      this.clearTimer(stream.timeout)
      stream.timeout = null
    }
    try {
      stream.releasePortHooks?.()
    } catch {
      // Listener teardown can race with port closure.
    }
    stream.releasePortHooks = null
    try {
      stream.port.close()
    } catch {
      // Best-effort cleanup only.
    }
  }
}
