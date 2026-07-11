/*
 * Renderer-side client for the IAMF decode worker. Lazily spawns the worker
 * (inline-bundled so it works under file:// in production), initializes it
 * with the wasm bytes from the preload, and serializes decode requests — the
 * wasm instance handles one stream at a time.
 *
 * Cancellation: `cancel()` marks the request in the worker (checked between
 * the driver's yield points). If the worker doesn't acknowledge within
 * CANCEL_TIMEOUT_MS the worker is terminated and respawned on next use — the
 * fallback for a decode wedged inside a long wasm call.
 */

import type { IamfWorkerDecodedMessage, IamfWorkerOutMessage } from './iamfDecodeWorker'
import type { IamfContainerKind } from '../../shared/iamf/detect'

export interface IamfDecodedAudio {
  sampleRate: number
  frames: number
  channels: number
  loudnessLufs: number | null
  channelData: Float32Array[]
}

export interface IamfDecodeHandle {
  promise: Promise<IamfDecodedAudio>
  cancel: () => void
}

export class IamfDecodeCancelledError extends Error {
  constructor() {
    super('IAMF decode cancelled')
    this.name = 'IamfDecodeCancelledError'
  }
}

const CANCEL_TIMEOUT_MS = 2000

interface PendingRequest {
  resolve: (result: IamfDecodedAudio) => void
  reject: (error: Error) => void
  cancelTimer: ReturnType<typeof setTimeout> | null
}

export class IamfDecoderClient {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  /** Serializes decodes; the worker's wasm state is single-stream. */
  private queue: Promise<unknown> = Promise.resolve()

  decode(bytes: ArrayBuffer, container: IamfContainerKind): IamfDecodeHandle {
    const requestId = this.nextRequestId++
    let cancelled = false

    const promise = (this.queue = this.queue.catch(() => undefined).then(async () => {
      if (cancelled) throw new IamfDecodeCancelledError()
      const worker = await this.ensureWorker()
      return new Promise<IamfDecodedAudio>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject, cancelTimer: null })
        worker.postMessage({ type: 'decode', requestId, bytes, container }, [bytes])
      })
    })) as Promise<IamfDecodedAudio>

    return {
      promise,
      cancel: () => {
        cancelled = true
        const pending = this.pending.get(requestId)
        if (!pending) return // not started yet (queue) or already settled
        this.worker?.postMessage({ type: 'cancel', requestId })
        pending.cancelTimer ??= setTimeout(() => {
          // Worker did not acknowledge — likely wedged inside a wasm call.
          if (this.pending.has(requestId)) this.restartWorker()
        }, CANCEL_TIMEOUT_MS)
      },
    }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker && this.ready) {
      await this.ready
      return this.worker
    }
    // Dynamic import keeps this Vite-specific specifier out of node's module
    // graph (the test loader can't resolve `?worker&inline`); it only ever
    // executes in the renderer.
    const { default: IamfDecodeWorker } = await import('./iamfDecodeWorker?worker&inline')
    const worker: Worker = new IamfDecodeWorker()
    this.worker = worker
    this.ready = (async () => {
      const wasmBytes = await window.electronAPI.getIamfWasmBytes()
      await new Promise<void>((resolve, reject) => {
        const onInit = (event: MessageEvent<IamfWorkerOutMessage>) => {
          const data = event.data
          if (data.type === 'ready') {
            worker.removeEventListener('message', onInit)
            worker.addEventListener('message', (e: MessageEvent<IamfWorkerOutMessage>) => {
              this.handleMessage(e.data)
            })
            resolve()
            return
          }
          if (data.type === 'init-error') {
            worker.removeEventListener('message', onInit)
            reject(new Error(`IAMF decoder failed to initialize: ${data.message}`))
          }
        }
        worker.addEventListener('message', onInit)
        worker.postMessage({ type: 'init', wasmBytes }, [wasmBytes])
      })
    })()
    try {
      await this.ready
    } catch (error) {
      this.restartWorker()
      throw error
    }
    return worker
  }

  private handleMessage(message: IamfWorkerOutMessage): void {
    if (message.type === 'progress') return // reserved for future load UI
    if (message.type !== 'decoded' && message.type !== 'decode-error' && message.type !== 'cancelled') {
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    if (pending.cancelTimer !== null) clearTimeout(pending.cancelTimer)

    if (message.type === 'decoded') {
      const decoded = message as IamfWorkerDecodedMessage
      pending.resolve({
        sampleRate: decoded.sampleRate,
        frames: decoded.frames,
        channels: decoded.channels,
        loudnessLufs: decoded.loudnessLufs,
        channelData: decoded.channelData,
      })
    } else if (message.type === 'cancelled') {
      pending.reject(new IamfDecodeCancelledError())
    } else {
      pending.reject(new Error(message.message))
    }
  }

  /** Terminates a wedged worker; pending requests reject, next use respawns. */
  private restartWorker(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    for (const [, pending] of this.pending) {
      if (pending.cancelTimer !== null) clearTimeout(pending.cancelTimer)
      pending.reject(new IamfDecodeCancelledError())
    }
    this.pending.clear()
  }
}
