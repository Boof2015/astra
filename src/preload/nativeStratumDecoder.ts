import type { NativeProgressiveInput } from '../types/nativeProgressive'
import type { NativeRemoteSource } from '../types/nativeRemoteSource'
import type { NativePcmDecoder } from './nativePcmDecoder'

/** Pull one bounded IPC packet at a time, then wait for native ring capacity.
 * No network/IPC/allocations are performed by the native audio callback. */
export function startNativeStratumDecoder(source: NativeRemoteSource, input: NativeProgressiveInput,
  signal: AbortSignal, onFailure: (error: Error) => void): NativePcmDecoder {
  const initial = input.status()
  const stride = initial.bytesPerFrame
  const channels = source.pcm!.info.channels
  const sourceStride = channels * 4
  const sampleBytes = stride / channels
  if (![2, 3, 4].includes(sampleBytes)) throw new Error('Unsupported Stratum native integer format.')
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
        if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 64 * 1024 || data.byteLength % sourceStride) {
          throw new Error('Invalid Stratum PCM packet.')
        }
        const sourceBytes = new Uint8Array(data)
        const bytes = sampleBytes === 4 ? sourceBytes : new Uint8Array(sourceBytes.length / 4 * sampleBytes)
        if (sampleBytes < 4) {
          // FFmpeg's s32 is left-aligned. Remove only zero padding, with no
          // floating-point conversion, rounding or dither. Reject real precision
          // loss instead of silently truncating it for a narrower device format.
          const padding = 4 - sampleBytes
          for (let from = 0, to = 0; from < sourceBytes.length; from += 4) {
            for (let byte = 0; byte < padding; byte++) {
              if (sourceBytes[from + byte] !== 0) throw new Error('Stratum PCM cannot fit the native integer format exactly.')
            }
            for (let byte = padding; byte < 4; byte++) bytes[to++] = sourceBytes[from + byte]
          }
        }
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
