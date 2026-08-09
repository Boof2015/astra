export type AudioBinaryName = 'ffmpeg' | 'ffprobe'

export type AudioBinaryResolver = (binary: AudioBinaryName) => Promise<string | null>

/**
 * Cache resolved binary paths (including an unavailable `null` result) while
 * coalescing callers that request the same unresolved binary concurrently.
 * A rejected lookup remains unresolved so a later request can retry it.
 */
export function createCachedAudioBinaryResolver(
  resolveUncached: AudioBinaryResolver
): AudioBinaryResolver {
  const resolved: Record<AudioBinaryName, string | null | undefined> = {
    ffmpeg: undefined,
    ffprobe: undefined
  }
  const inFlight = new Map<AudioBinaryName, Promise<string | null>>()

  return (binary) => {
    const cached = resolved[binary]
    if (cached !== undefined) return Promise.resolve(cached)

    const pending = inFlight.get(binary)
    if (pending) return pending

    let tracked: Promise<string | null>
    tracked = resolveUncached(binary)
      .then((result) => {
        resolved[binary] = result
        return result
      })
      .finally(() => {
        if (inFlight.get(binary) === tracked) {
          inFlight.delete(binary)
        }
      })
    inFlight.set(binary, tracked)
    return tracked
  }
}
