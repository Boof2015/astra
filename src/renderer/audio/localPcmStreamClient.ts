import {
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_MAX_BYTES,
  LOCAL_PCM_STREAM_VERSION,
  isLocalPcmStreamMainMessage,
  isLocalPcmStreamPortEnvelope,
  validateLocalPcmStreamOpenRequest,
  type LocalPcmStreamCompleteMessage,
  type LocalPcmStreamMainTransportTimings,
  type LocalPcmStreamOpenRequest,
  type LocalPcmStreamPriority,
  type LocalPcmStreamRendererMessage,
} from '../../shared/localPcmStream'
import type { PcmTransportTimings } from './pcmTransportTimings'

export const LOCAL_PCM_STREAM_HANDSHAKE_TIMEOUT_MS = 2_000

const FLOAT32_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT

export interface LocalPcmStreamDecodeRequest {
  requestId: number
  filePath: string
  outputSampleRate: number
  expectedChannels?: number | null
  priority?: LocalPcmStreamPriority
}

export interface LocalPcmStreamResultTransportTimings extends LocalPcmStreamMainTransportTimings {
  transportRoute: 'message_port_stream'
  /** Compatibility placeholder ignored for the streamed route. */
  preloadInvokeMs: 0
  rendererPcmAssemblyAllocationMs: number
  rendererPcmAssemblyCopyMs: number
  rendererPortRequestMs: number
}

/** Common shape shared by the stream and unchanged legacy invoke result. */
export interface LocalPcmCompatibleDecodeResult {
  requestId: number
  sampleRate: number
  channels: number
  frames: number
  pcmByteLength: number
  interleavedPcm: ArrayBuffer
  probeMs: number
  decodeMs: number
  backgroundPriorityApplied: boolean
  transportTimings?: PcmTransportTimings
}

/** Same PCM envelope consumed by the existing Standard AudioEngine path. */
export interface LocalPcmStreamDecodeResult extends LocalPcmCompatibleDecodeResult {
  transportTimings: LocalPcmStreamResultTransportTimings
}

export type LocalPcmStreamTransportErrorCode =
  | 'unavailable'
  | 'open_rejected'
  | 'handshake_timeout'
  | 'protocol_error'
  | 'port_closed'
  | 'message_error'
  | 'post_failed'
  | 'disposed'

export class LocalPcmStreamTransportError extends Error {
  readonly code: LocalPcmStreamTransportErrorCode

  constructor(code: LocalPcmStreamTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPcmStreamTransportError'
    this.code = code
  }
}

export class LocalPcmStreamDecodeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LocalPcmStreamDecodeError'
    this.code = code
  }
}

export class LocalPcmStreamCancelledError extends Error {
  constructor(message = 'Local PCM stream request was cancelled.') {
    super(message)
    this.name = 'LocalPcmStreamCancelledError'
  }
}

export function isLocalPcmStreamTransportError(error: unknown): error is LocalPcmStreamTransportError {
  return error instanceof LocalPcmStreamTransportError
}

export function isLocalPcmStreamDecodeError(error: unknown): error is LocalPcmStreamDecodeError {
  return error instanceof LocalPcmStreamDecodeError
}

export function isLocalPcmStreamCancelledError(error: unknown): error is LocalPcmStreamCancelledError {
  return error instanceof LocalPcmStreamCancelledError
}

export type OpenLocalAudioPcmStream = (
  requestId: number,
  filePath: string,
  outputSampleRate: number,
  expectedChannels: number | null,
  priority: LocalPcmStreamPriority,
  nonce: string,
) => boolean

interface LocalPcmStreamPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  onclose: ((event: Event) => void) | null
  postMessage(message: LocalPcmStreamRendererMessage): void
  start(): void
  close(): void
}

type WindowMessageListener = (event: MessageEvent<unknown>) => void

export interface LocalPcmStreamWindowTarget {
  readonly sourceIdentity: MessageEventSource | null
  addMessageListener(listener: WindowMessageListener): void
  removeMessageListener(listener: WindowMessageListener): void
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export interface LocalPcmStreamClientRuntime {
  windowTarget: LocalPcmStreamWindowTarget
  openLocalAudioPcmStream: OpenLocalAudioPcmStream
  monotonicNow?: () => number
  createNonce?: () => string
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  handshakeTimeoutMs?: number
}

export interface LocalPcmStreamClient {
  decode(request: LocalPcmStreamDecodeRequest): Promise<LocalPcmStreamDecodeResult>
  cancel(requestId: number): boolean
  dispose(): void
  hasPending(requestId: number): boolean
  readonly pendingCount: number
}

interface PendingLocalPcmStream {
  request: Required<Pick<LocalPcmStreamDecodeRequest, 'requestId' | 'filePath' | 'outputSampleRate'>> & {
    expectedChannels: number | null
    priority: LocalPcmStreamPriority
  }
  nonce: string
  startedAt: number
  state: 'waiting_port' | 'waiting_accept' | 'accepted' | 'started'
  port: LocalPcmStreamPort | null
  handshakeTimer: TimerHandle | null
  sampleRate: number | null
  channels: number | null
  pcmBuffer: ArrayBuffer | null
  receivedBytes: number
  nextSequence: number
  chunkCount: number
  resizeCount: number
  rendererPcmAssemblyAllocationMs: number
  rendererPcmAssemblyCopyMs: number
  settled: boolean
  resolve: (result: LocalPcmStreamDecodeResult) => void
  reject: (error: Error) => void
}

function roundDiagnosticMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

function defaultNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `pcm_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function makeOpenRequest(request: LocalPcmStreamDecodeRequest, nonce: string): LocalPcmStreamOpenRequest {
  return {
    requestId: request.requestId,
    filePath: request.filePath,
    outputSampleRate: request.outputSampleRate,
    expectedChannels: request.expectedChannels ?? null,
    priority: request.priority === 'background' ? 'background' : 'interactive',
    nonce,
  }
}

function transportError(
  code: LocalPcmStreamTransportErrorCode,
  message: string,
  cause?: unknown,
): LocalPcmStreamTransportError {
  return new LocalPcmStreamTransportError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function validateCompleteAgainstAssembly(
  pending: PendingLocalPcmStream,
  message: LocalPcmStreamCompleteMessage,
): string | null {
  const channels = pending.channels
  const pcmBuffer = pending.pcmBuffer
  if (channels === null || pcmBuffer === null || pending.sampleRate === null) {
    return 'PCM stream completed before its start metadata and allocation.'
  }
  const expectedByteLength = message.frames * channels * FLOAT32_BYTES_PER_SAMPLE
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength !== message.pcmByteLength) {
    return 'PCM stream completion dimensions do not match its valid byte length.'
  }
  if (message.pcmByteLength !== pending.receivedBytes) {
    return 'PCM stream completion byte length does not match the received prefix.'
  }
  if (message.pcmByteLength > pcmBuffer.byteLength) {
    return 'PCM stream completion exceeds the current renderer allocation.'
  }
  if (message.chunkCount !== pending.chunkCount || message.chunkCount !== pending.nextSequence) {
    return 'PCM stream completion chunk count does not match the received sequence.'
  }

  const timings = message.transportTimings
  if (timings.decodeRequestId !== pending.request.requestId) {
    return 'PCM stream timing correlation does not match the request ID.'
  }
  if (timings.validPcmBytes !== message.pcmByteLength) {
    return 'PCM stream timing valid-byte count does not match completion metadata.'
  }
  if (timings.backingBufferBytes !== pcmBuffer.byteLength) {
    return 'PCM stream timing backing-buffer count does not match renderer allocation.'
  }
  if (timings.allocationGrowthCount !== pending.resizeCount) {
    return 'PCM stream allocation growth count does not match received resize messages.'
  }
  if (timings.streamChunkCount !== message.chunkCount) {
    return 'PCM stream timing chunk count does not match completion metadata.'
  }
  if (timings.probeMs !== message.probeMs || timings.ffmpegMs !== message.decodeMs) {
    return 'PCM stream decoder timings do not match completion metadata.'
  }
  return null
}

export function createLocalPcmStreamClient(runtime: LocalPcmStreamClientRuntime): LocalPcmStreamClient {
  const monotonicNow = runtime.monotonicNow ?? (() => performance.now())
  const createNonce = runtime.createNonce ?? defaultNonce
  const setTimer = runtime.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const clearTimer = runtime.clearTimer ?? ((handle) => globalThis.clearTimeout(handle))
  const handshakeTimeoutMs = runtime.handshakeTimeoutMs ?? LOCAL_PCM_STREAM_HANDSHAKE_TIMEOUT_MS
  const pendingByRequestId = new Map<number, PendingLocalPcmStream>()
  let disposed = false

  const clearHandshakeTimer = (pending: PendingLocalPcmStream): void => {
    if (pending.handshakeTimer === null) return
    clearTimer(pending.handshakeTimer)
    pending.handshakeTimer = null
  }

  const detachAndClosePort = (pending: PendingLocalPcmStream, sendCancel: boolean): void => {
    const port = pending.port
    pending.port = null
    if (!port) return
    port.onmessage = null
    port.onmessageerror = null
    port.onclose = null
    if (sendCancel) {
      try {
        port.postMessage({
          type: 'cancel',
          version: LOCAL_PCM_STREAM_VERSION,
          requestId: pending.request.requestId,
          nonce: pending.nonce,
        })
      } catch {
        // The transport is already unusable; closing still releases it.
      }
    }
    try {
      port.close()
    } catch {
      // Port teardown may race with remote closure.
    }
  }

  const rejectPending = (
    pending: PendingLocalPcmStream,
    error: Error,
    sendCancel: boolean,
  ): void => {
    if (pending.settled) return
    pending.settled = true
    pendingByRequestId.delete(pending.request.requestId)
    clearHandshakeTimer(pending)
    // Release the potentially 192 MiB assembly before promise observers run.
    pending.pcmBuffer = null
    detachAndClosePort(pending, sendCancel)
    pending.reject(error)
  }

  const resolvePending = (
    pending: PendingLocalPcmStream,
    message: LocalPcmStreamCompleteMessage,
  ): void => {
    if (pending.settled || pending.pcmBuffer === null || pending.sampleRate === null || pending.channels === null) {
      return
    }
    const interleavedPcm = pending.pcmBuffer
    const rendererPortRequestMs = roundDiagnosticMs(monotonicNow() - pending.startedAt)
    const result: LocalPcmStreamDecodeResult = {
      requestId: pending.request.requestId,
      sampleRate: pending.sampleRate,
      channels: pending.channels,
      frames: message.frames,
      pcmByteLength: message.pcmByteLength,
      interleavedPcm,
      probeMs: message.probeMs,
      decodeMs: message.decodeMs,
      backgroundPriorityApplied: message.backgroundPriorityApplied,
      transportTimings: {
        ...message.transportTimings,
        transportRoute: 'message_port_stream',
        preloadInvokeMs: 0,
        rendererPcmAssemblyAllocationMs: roundDiagnosticMs(pending.rendererPcmAssemblyAllocationMs),
        rendererPcmAssemblyCopyMs: roundDiagnosticMs(pending.rendererPcmAssemblyCopyMs),
        rendererPortRequestMs,
      },
    }

    pending.settled = true
    pendingByRequestId.delete(pending.request.requestId)
    clearHandshakeTimer(pending)
    pending.pcmBuffer = null
    detachAndClosePort(pending, false)
    pending.resolve(result)
  }

  const postToMain = (
    pending: PendingLocalPcmStream,
    message: LocalPcmStreamRendererMessage,
  ): boolean => {
    const port = pending.port
    if (!port) return false
    try {
      port.postMessage(message)
      return true
    } catch (error) {
      rejectPending(
        pending,
        transportError('post_failed', 'Failed to post a PCM stream control message.', error),
        true,
      )
      return false
    }
  }

  const handlePortMessage = (pending: PendingLocalPcmStream, rawMessage: unknown): void => {
    if (pending.settled) return
    if (!isLocalPcmStreamMainMessage(rawMessage)) {
      rejectPending(
        pending,
        transportError('protocol_error', 'PCM stream received a malformed main-process message.'),
        true,
      )
      return
    }
    if (rawMessage.requestId !== pending.request.requestId || rawMessage.nonce !== pending.nonce) {
      rejectPending(
        pending,
        transportError('protocol_error', 'PCM stream received stale or mismatched request correlation.'),
        true,
      )
      return
    }

    switch (rawMessage.type) {
      case 'accepted': {
        if (pending.state !== 'waiting_accept') {
          rejectPending(pending, transportError('protocol_error', 'PCM stream acceptance was out of order.'), true)
          return
        }
        pending.state = 'accepted'
        clearHandshakeTimer(pending)
        return
      }
      case 'start': {
        if (
          pending.state !== 'accepted'
          || pending.pcmBuffer !== null
          || rawMessage.sampleRate !== pending.request.outputSampleRate
        ) {
          rejectPending(pending, transportError('protocol_error', 'PCM stream start metadata was out of order.'), true)
          return
        }
        const allocationStartedAt = monotonicNow()
        try {
          pending.pcmBuffer = new ArrayBuffer(rawMessage.backingBufferBytes)
        } catch (error) {
          rejectPending(
            pending,
            transportError('protocol_error', 'Renderer could not allocate the bounded PCM stream buffer.', error),
            true,
          )
          return
        }
        pending.rendererPcmAssemblyAllocationMs += monotonicNow() - allocationStartedAt
        pending.sampleRate = rawMessage.sampleRate
        pending.channels = rawMessage.channels
        pending.state = 'started'
        return
      }
      case 'resize': {
        const previous = pending.pcmBuffer
        if (
          pending.state !== 'started'
          || previous === null
          || rawMessage.backingBufferBytes <= previous.byteLength
          || rawMessage.backingBufferBytes > LOCAL_PCM_STREAM_MAX_BYTES
        ) {
          rejectPending(pending, transportError('protocol_error', 'PCM stream resize was invalid or out of order.'), true)
          return
        }

        let next: ArrayBuffer
        const allocationStartedAt = monotonicNow()
        try {
          next = new ArrayBuffer(rawMessage.backingBufferBytes)
        } catch (error) {
          rejectPending(
            pending,
            transportError('protocol_error', 'Renderer could not grow the bounded PCM stream buffer.', error),
            true,
          )
          return
        }
        pending.rendererPcmAssemblyAllocationMs += monotonicNow() - allocationStartedAt

        const copyStartedAt = monotonicNow()
        new Uint8Array(next, 0, pending.receivedBytes).set(
          new Uint8Array(previous, 0, pending.receivedBytes),
        )
        pending.rendererPcmAssemblyCopyMs += monotonicNow() - copyStartedAt
        pending.pcmBuffer = next
        pending.resizeCount += 1
        return
      }
      case 'chunk': {
        const pcmBuffer = pending.pcmBuffer
        if (
          pending.state !== 'started'
          || pcmBuffer === null
          || rawMessage.sequence !== pending.nextSequence
          || rawMessage.byteOffset !== pending.receivedBytes
          || rawMessage.byteOffset + rawMessage.byteLength > pcmBuffer.byteLength
        ) {
          rejectPending(pending, transportError('protocol_error', 'PCM stream chunk sequence or offset was invalid.'), true)
          return
        }

        const copyStartedAt = monotonicNow()
        new Uint8Array(pcmBuffer, rawMessage.byteOffset, rawMessage.byteLength).set(
          new Uint8Array(rawMessage.payload),
        )
        pending.rendererPcmAssemblyCopyMs += monotonicNow() - copyStartedAt
        pending.receivedBytes += rawMessage.byteLength
        pending.nextSequence += 1
        pending.chunkCount += 1
        postToMain(pending, {
          type: 'credit',
          version: LOCAL_PCM_STREAM_VERSION,
          requestId: pending.request.requestId,
          nonce: pending.nonce,
          sequence: rawMessage.sequence,
          credits: 1,
        })
        return
      }
      case 'complete': {
        if (pending.state !== 'started') {
          rejectPending(pending, transportError('protocol_error', 'PCM stream completion was out of order.'), true)
          return
        }
        const validationError = validateCompleteAgainstAssembly(pending, rawMessage)
        if (validationError) {
          rejectPending(pending, transportError('protocol_error', validationError), true)
          return
        }
        resolvePending(pending, rawMessage)
        return
      }
      case 'cancelled':
        rejectPending(pending, new LocalPcmStreamCancelledError(), false)
        return
      case 'error':
        rejectPending(
          pending,
          rawMessage.kind === 'decode'
            ? new LocalPcmStreamDecodeError(rawMessage.code, rawMessage.message)
            : transportError('protocol_error', rawMessage.message),
          false,
        )
        return
    }
  }

  const attachPort = (pending: PendingLocalPcmStream, port: LocalPcmStreamPort): void => {
    if (pending.state !== 'waiting_port' || pending.port !== null) {
      try {
        port.close()
      } catch {
        // Ignore disposal of an unexpected duplicate port.
      }
      return
    }
    pending.port = port
    pending.state = 'waiting_accept'
    port.onmessage = (event) => handlePortMessage(pending, event.data)
    port.onmessageerror = () => {
      rejectPending(pending, transportError('message_error', 'PCM stream message deserialization failed.'), true)
    }
    port.onclose = () => {
      rejectPending(pending, transportError('port_closed', 'PCM stream port closed before completion.'), false)
    }
    try {
      port.start()
    } catch (error) {
      rejectPending(pending, transportError('protocol_error', 'PCM stream port could not be started.', error), true)
      return
    }
    postToMain(pending, {
      type: 'ready',
      version: LOCAL_PCM_STREAM_VERSION,
      requestId: pending.request.requestId,
      nonce: pending.nonce,
      credits: LOCAL_PCM_STREAM_INITIAL_CREDITS,
    })
  }

  const handleWindowMessage: WindowMessageListener = (event) => {
    if (event.source !== runtime.windowTarget.sourceIdentity) return
    if (!isLocalPcmStreamPortEnvelope(event.data)) return

    const pending = pendingByRequestId.get(event.data.requestId)
    // Multiple isolated clients may share the renderer window (for example,
    // playback plus the diagnostics-only transfer benchmark). Only the client
    // that owns the exact request/nonce pair may consume or close its port.
    if (!pending || pending.nonce !== event.data.nonce) return
    if (event.ports.length !== 1) {
      for (const unexpectedPort of event.ports) {
        try {
          unexpectedPort.close()
        } catch {
          // Ignore malformed transferred-port cleanup failures.
        }
      }
      return
    }
    attachPort(pending, event.ports[0] as unknown as LocalPcmStreamPort)
  }

  runtime.windowTarget.addMessageListener(handleWindowMessage)

  return {
    decode(request): Promise<LocalPcmStreamDecodeResult> {
      if (disposed) {
        return Promise.reject(transportError('disposed', 'PCM stream client has been disposed.'))
      }

      const nonce = createNonce()
      const openRequest = makeOpenRequest(request, nonce)
      if (!validateLocalPcmStreamOpenRequest(openRequest)) {
        return Promise.reject(transportError('open_rejected', 'PCM stream request failed local validation.'))
      }

      const existing = pendingByRequestId.get(openRequest.requestId)
      if (existing) {
        rejectPending(existing, new LocalPcmStreamCancelledError('Local PCM stream request ID was reused.'), true)
      }

      return new Promise<LocalPcmStreamDecodeResult>((resolve, reject) => {
        const pending: PendingLocalPcmStream = {
          request: {
            requestId: openRequest.requestId,
            filePath: openRequest.filePath,
            outputSampleRate: openRequest.outputSampleRate,
            expectedChannels: openRequest.expectedChannels,
            priority: openRequest.priority,
          },
          nonce,
          startedAt: monotonicNow(),
          state: 'waiting_port',
          port: null,
          handshakeTimer: null,
          sampleRate: null,
          channels: null,
          pcmBuffer: null,
          receivedBytes: 0,
          nextSequence: 0,
          chunkCount: 0,
          resizeCount: 0,
          rendererPcmAssemblyAllocationMs: 0,
          rendererPcmAssemblyCopyMs: 0,
          settled: false,
          resolve,
          reject,
        }
        pendingByRequestId.set(openRequest.requestId, pending)
        pending.handshakeTimer = setTimer(() => {
          rejectPending(
            pending,
            transportError('handshake_timeout', 'PCM stream port handshake timed out.'),
            true,
          )
        }, handshakeTimeoutMs)

        try {
          const opened = runtime.openLocalAudioPcmStream(
            openRequest.requestId,
            openRequest.filePath,
            openRequest.outputSampleRate,
            openRequest.expectedChannels,
            openRequest.priority,
            openRequest.nonce,
          )
          if (opened !== true) {
            rejectPending(
              pending,
              transportError('open_rejected', 'PCM stream endpoint declined the request.'),
              false,
            )
          }
        } catch (error) {
          rejectPending(
            pending,
            transportError('open_rejected', 'PCM stream endpoint could not be opened.', error),
            false,
          )
        }
      })
    },

    cancel(requestId): boolean {
      const pending = pendingByRequestId.get(requestId)
      if (!pending) return false
      rejectPending(pending, new LocalPcmStreamCancelledError(), true)
      return true
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      runtime.windowTarget.removeMessageListener(handleWindowMessage)
      for (const pending of [...pendingByRequestId.values()]) {
        rejectPending(
          pending,
          transportError('disposed', 'PCM stream client was disposed before completion.'),
          true,
        )
      }
    },

    hasPending(requestId): boolean {
      return pendingByRequestId.has(requestId)
    },

    get pendingCount(): number {
      return pendingByRequestId.size
    },
  }
}

export interface LocalPcmStreamDecodeOptions {
  client?: LocalPcmStreamClient
}

let defaultClient: LocalPcmStreamClient | null = null
let defaultClientWindow: Window | null = null

function createDefaultClient(): LocalPcmStreamClient {
  if (typeof window === 'undefined') {
    throw transportError('unavailable', 'PCM stream transport is unavailable outside a renderer window.')
  }
  const api = (window as unknown as {
    electronAPI?: { openLocalAudioPcmStream?: OpenLocalAudioPcmStream }
  }).electronAPI
  const openLocalAudioPcmStream = api?.openLocalAudioPcmStream
  if (!openLocalAudioPcmStream) {
    throw transportError('unavailable', 'PCM stream endpoint is unavailable; use legacy invoke transport.')
  }

  return createLocalPcmStreamClient({
    windowTarget: {
      sourceIdentity: window,
      addMessageListener: (listener) => window.addEventListener('message', listener),
      removeMessageListener: (listener) => window.removeEventListener('message', listener),
    },
    openLocalAudioPcmStream: (...args) => openLocalAudioPcmStream(...args),
  })
}

function getDefaultClient(): LocalPcmStreamClient {
  if (typeof window !== 'undefined' && defaultClientWindow !== window) {
    defaultClient?.dispose()
    defaultClient = null
    defaultClientWindow = window
  }
  defaultClient ??= createDefaultClient()
  return defaultClient
}

export function decodeLocalAudioPcmViaStream(
  request: LocalPcmStreamDecodeRequest,
  options: LocalPcmStreamDecodeOptions = {},
): Promise<LocalPcmStreamDecodeResult> {
  try {
    return (options.client ?? getDefaultClient()).decode(request)
  } catch (error) {
    return Promise.reject(
      isLocalPcmStreamTransportError(error)
        ? error
        : transportError('unavailable', 'PCM stream transport could not be initialized.', error),
    )
  }
}

export type LegacyLocalPcmDecode = (
  () => Promise<LocalPcmCompatibleDecodeResult | null>
) | null | undefined

/**
 * Uses the bounded stream when available. Only transport/protocol failures
 * retry through the unchanged invoke route; decoder failures are authoritative.
 */
export async function preferLocalPcmStreamWithLegacyFallback(
  request: LocalPcmStreamDecodeRequest,
  legacyDecode: LegacyLocalPcmDecode,
  options: LocalPcmStreamDecodeOptions = {},
): Promise<LocalPcmCompatibleDecodeResult | null> {
  try {
    return await decodeLocalAudioPcmViaStream(request, options)
  } catch (error) {
    if (isLocalPcmStreamCancelledError(error)) return null
    if (!isLocalPcmStreamTransportError(error) || !legacyDecode) throw error
    return legacyDecode()
  }
}

/** Releases renderer assembly memory synchronously before notifying observers. */
export function cancelLocalPcmStreamRequest(requestId: number): boolean {
  return defaultClient?.cancel(requestId) ?? false
}
