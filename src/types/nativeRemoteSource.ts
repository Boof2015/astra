import type { RemotePlaybackQuality } from './streamingQuality'
/** Internal main/preload transport; never expose decoder URLs to the renderer. */
export interface NativeRemoteProgress {
  loadedBytes: number
  totalBytes: number | null
  complete: boolean
  error: string | null
}

export interface NativeRemoteSource {
  quality?: RemotePlaybackQuality
  url: string
  duration: number
  progress(): Promise<NativeRemoteProgress>
  finished(): Promise<void>
  release(): void
}
