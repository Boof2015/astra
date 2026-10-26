import type { NativeProgressiveInput } from '../types/nativeProgressive'
import type { NativeRemoteSource } from '../types/nativeRemoteSource'
import type { NativePcmDecoder } from './nativePcmDecoder'

/** Pull one bounded IPC packet at a time, then wait for native ring capacity.
 * No network/IPC/allocations are performed by the native audio callback. */
export function startNativeStratumDecoder(source: NativeRemoteSource, input: NativeProgressiveInput,
  signal: AbortSignal, onFailure: (error: Error) => void): NativePcmDecoder {
  const initial = input.status()
  const stride = initial.bytesPerFrame
  let pendingBytes = 0, cancelled = false, settled = false, readySettled = false
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const abortError = () => Object.assign(new Error('Native Stratum decoder was cancelled.'), { name: 'AbortError' })
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    input.cancel()
    source.release()
    if (!readySettled) { readySettled = true; rejectReady(abortError()) }
  }
  const active = () => {
    if (signal.aborted || cancelled || input.status().state === 'cancelled') throw abortError()
  }
  signal.addEventListener('abort', cancel, { once: true })
  // Cancellation can come from the native engine at a handoff without a JS abort.
  const monitor = setInterval(() => { if (input.status().state === 'cancelled') cancel() }, 20)
  monitor.unref?.()
  const done = (async () => {
    try {
      while (true) {
        active()
        const data = await source.pcm!.read()
        active()
        if (data === null) break
        if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 64 * 1024 || data.byteLength % stride) {
          throw new Error('Invalid Stratum PCM packet.')
        }
        const bytes = new Uint8Array(data)
        let offset = 0
        pendingBytes = bytes.length
        while (offset < bytes.length) {
          active()
          const accepted = input.append(bytes.subarray(offset))
          if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted * stride > bytes.length - offset) {
            throw new Error('Native input returned an invalid accepted frame count.')
          }
          offset += accepted * stride; pendingBytes = bytes.length - offset
          if (!readySettled && input.status().publishedFrame - initial.startFrame >= Math.ceil(initial.sampleRate * .75)) {
            readySettled = true; resolveReady()
          }
          if (offset < bytes.length) await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
      }
      await source.finished()
      active()
      if (input.status().publishedFrame === initial.startFrame) throw new Error('Stratum produced no audio frames.')
      if (!input.finish()) throw abortError()
      if (!readySettled) { readySettled = true; resolveReady() }
    } catch (error) {
      const failure = cancelled || signal.aborted ? abortError() : error instanceof Error ? error : new Error('Stratum playback failed.')
      if (!readySettled) { readySettled = true; rejectReady(failure) }
      if (failure.name !== 'AbortError') onFailure(failure)
      throw failure
    } finally {
      settled = true; pendingBytes = 0
      clearInterval(monitor)
      signal.removeEventListener('abort', cancel)
    }
  })()
  void done.catch(() => {})
  if (signal.aborted) cancel()
  return { ready, done, cancel, pid: undefined, get pendingBytes() { return settled ? 0 : pendingBytes } }
}
