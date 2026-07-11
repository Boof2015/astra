/*
 * IAMF decode worker. Owns one wasm decoder instance (iamf-decoder.wasm,
 * bytes delivered by the client — a worker cannot reach the preload API) and
 * decodes whole files off the UI thread. The client (iamfDecoder.ts)
 * serializes decode requests; cancel arrives between the driver's yield
 * points.
 *
 * Bundled inline (`?worker&inline`) so it loads under file:// in production.
 */

import {
  decodeIamfObuStream,
  instantiateIamfDecoder,
  IamfDecodeError,
  type IamfWasmExports,
} from '../../shared/iamf/iamfWasmDriver'
import { extractIamfObuStreamFromMp4 } from '../../shared/iamf/mp4'
import type { IamfContainerKind } from '../../shared/iamf/detect'

export interface IamfWorkerInitMessage {
  type: 'init'
  wasmBytes: ArrayBuffer
}

export interface IamfWorkerDecodeMessage {
  type: 'decode'
  requestId: number
  bytes: ArrayBuffer
  container: IamfContainerKind
}

export interface IamfWorkerCancelMessage {
  type: 'cancel'
  requestId: number
}

export type IamfWorkerInMessage =
  | IamfWorkerInitMessage
  | IamfWorkerDecodeMessage
  | IamfWorkerCancelMessage

export interface IamfWorkerDecodedMessage {
  type: 'decoded'
  requestId: number
  sampleRate: number
  frames: number
  channels: number
  loudnessLufs: number | null
  channelData: Float32Array[]
}

export type IamfWorkerOutMessage =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'progress'; requestId: number; framesDecoded: number; totalFrames: number | null }
  | IamfWorkerDecodedMessage
  | { type: 'decode-error'; requestId: number; message: string; code: number | null }
  | { type: 'cancelled'; requestId: number }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<IamfWorkerInMessage>) => void) | null
  postMessage: (message: IamfWorkerOutMessage, transfer?: Transferable[]) => void
}

let wasm: IamfWasmExports | null = null
const cancelledRequests = new Set<number>()

const yieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleDecode(request: IamfWorkerDecodeMessage): Promise<void> {
  const { requestId } = request
  if (!wasm) {
    scope.postMessage({ type: 'decode-error', requestId, message: 'IAMF decoder not initialized', code: null })
    return
  }
  try {
    const bytes = new Uint8Array(request.bytes)
    const obuStream = request.container === 'mp4' ? extractIamfObuStreamFromMp4(bytes) : bytes
    const result = await decodeIamfObuStream(wasm, obuStream, {
      yieldToHost,
      shouldCancel: () => cancelledRequests.has(requestId),
      onProgress: (framesDecoded, totalFrames) => {
        scope.postMessage({ type: 'progress', requestId, framesDecoded, totalFrames })
      },
    })
    if (cancelledRequests.delete(requestId)) {
      scope.postMessage({ type: 'cancelled', requestId })
      return
    }
    scope.postMessage(
      {
        type: 'decoded',
        requestId,
        sampleRate: result.sampleRate,
        frames: result.frames,
        channels: result.channels,
        loudnessLufs: result.loudnessLufs,
        channelData: result.channelData,
      },
      result.channelData.map((data) => data.buffer)
    )
  } catch (error) {
    if (cancelledRequests.delete(requestId)) {
      scope.postMessage({ type: 'cancelled', requestId })
      return
    }
    scope.postMessage({
      type: 'decode-error',
      requestId,
      message: errorMessage(error),
      code: error instanceof IamfDecodeError ? error.code : null,
    })
  }
}

scope.onmessage = (event: MessageEvent<IamfWorkerInMessage>) => {
  const data = event.data
  if (data.type === 'init') {
    void instantiateIamfDecoder(data.wasmBytes)
      .then((exports) => {
        wasm = exports
        scope.postMessage({ type: 'ready' })
      })
      .catch((error) => {
        scope.postMessage({ type: 'init-error', message: errorMessage(error) })
      })
    return
  }
  if (data.type === 'cancel') {
    cancelledRequests.add(data.requestId)
    return
  }
  if (data.type === 'decode') {
    void handleDecode(data)
  }
}
