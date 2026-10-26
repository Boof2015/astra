import { randomUUID } from 'node:crypto'
import type { NativeRemoteSource, NativeRemoteRequest, NativeStratumInfo, NativeRemoteProgress } from '../types/nativeRemoteSource'
import type { StreamingQualityRequest } from '../types/streamingQuality'

export function createNativeRemoteSourceResolver(invoke: (channel: string, ...args: unknown[]) => Promise<any>) {
  return async (path: string, signal: AbortSignal, quality?: StreamingQualityRequest, request?: NativeRemoteRequest): Promise<NativeRemoteSource> => {
    signal.throwIfAborted()
    if (request?.policy === 'processed' && path.startsWith('subsonic://')) {
      const stratum = await acquireStratum(invoke, path, signal, quality, request)
      if (stratum) return stratum
    }
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

async function acquireStratum(invoke: (channel: string, ...args: unknown[]) => Promise<any>, path: string,
  signal: AbortSignal, quality: StreamingQualityRequest | undefined, request: NativeRemoteRequest): Promise<NativeRemoteSource | null> {
  signal.throwIfAborted()
  const id = randomUUID()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    signal.removeEventListener('abort', release)
    return closing ??= invoke('native-stratum:release', id).then(() => {})
  }
  const release = () => { void close().catch(() => {}) }
  const pending = invoke('native-stratum:open', id, path, quality, request)
  signal.addEventListener('abort', release, { once: true })
  if (signal.aborted) release()
  try {
    const info: NativeStratumInfo | null = await pending
    signal.throwIfAborted()
    if (!info) { await close(); return null }
    const source: NativeRemoteSource = {
      url: '', duration: info.duration, quality: info.quality, release,
      finished: () => invoke('native-stratum:finished', id),
      progress: async (position, bufferedEnd, outputRate) => {
        const progress: NativeRemoteProgress = await invoke('native-stratum:progress', id, position, bufferedEnd, outputRate)
        if (progress.quality) source.quality = progress.quality
        return progress
      },
      pcm: { info, read: () => invoke('native-stratum:read', id), close,
        activate: () => { void invoke('native-stratum:activate', id).catch(() => {}) } }
    }
    return source
  } catch (error) { release(); throw error }
}
