import { randomUUID } from 'node:crypto'
import type { NativeRemoteSource } from '../types/nativeRemoteSource'
import type { StreamingQualityRequest } from '../types/streamingQuality'

export function createNativeRemoteSourceResolver(invoke: (channel: string, ...args: unknown[]) => Promise<any>) {
  return async (path: string, signal: AbortSignal, quality?: StreamingQualityRequest): Promise<NativeRemoteSource> => {
    signal.throwIfAborted()
    const id = randomUUID()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal.removeEventListener('abort', release)
      void invoke('native-remote:release', id).catch(() => {})
    }
    // IPC ordering registers acquisition before cancellation can release it.
    const acquisition = invoke('native-remote:acquire', id, path, quality)
    signal.addEventListener('abort', release, { once: true })
    if (signal.aborted) release()
    try {
      const result = await acquisition
      signal.throwIfAborted()
      return {
        url: result.url, duration: result.duration, quality: result.quality,
        progress: () => invoke('native-remote:progress', id),
        finished: () => invoke('native-remote:finished', id),
        release
      }
    } catch (error) { release(); throw error }
  }
}
