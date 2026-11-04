import type { RemotePlaybackQuality, StreamingQualityRequest } from '../../types/streamingQuality'

/** Only call with decoder diagnostics, never an arbitrary playback/device error.
 * Invalid/truncated input and generic "unsupported" messages are not evidence
 * that another encode can fix the problem.
 */
export function isUnsupportedRemoteDecoder(diagnostic: string): boolean {
  return /(?:decoder\s*\(codec\s+[^)]+\)\s+not found|decoding requested, but no decoder found|no decoder (?:could be )?found for (?:codec|audio)|(?:audio )?decoder ['"]?[^\s'"]+['"]? not found)/i.test(diagnostic)
    || /(?:decod(?:er|ing)|audio codec)[^\r\n]*(?:not (?:yet )?implemented|not supported in this (?:build|version))/i.test(diagnostic)
}

/** Internal evidence produced at the decoder/HTTP boundary before any PCM was
 * accepted. Do not classify ordinary exceptions in the retry loop itself. */
export class RemoteCompatibilityFailure extends Error {
  readonly quality: RemotePlaybackQuality
  constructor(quality: RemotePlaybackQuality, message: string) {
    super(message)
    this.quality = quality
    this.name = 'RemoteCompatibilityFailure'
  }
}

/** Original -> FLAC -> Opus -> MP3; bitrate-limited Opus -> forced MP3. A candidate
 * can only fail over on another explicit format failure. Cancellation, network,
 * auth, corrupt media, resource limits and device errors stop immediately.
 */
export async function withRemoteCompatibility<T>(request: StreamingQualityRequest | undefined,
  signal: AbortSignal, attempt: (request: StreamingQualityRequest | undefined) => Promise<T>): Promise<T> {
  const tried = new Set<string>()
  for (;;) {
    signal.throwIfAborted()
    try { return await attempt(request) }
    catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof RemoteCompatibilityFailure)) throw error
      const quality = error.quality
      const compatibility = quality.compatibility === 'mp3' ? null
        : quality.compatibility === 'opus' ? 'mp3'
        : quality.compatibility === 'flac' ? 'opus'
        : quality.requested === 'original' ? 'flac'
        : quality.requestedCodec === null ? 'opus' : 'mp3'
      if (!compatibility || tried.has(compatibility)) throw error
      tried.add(compatibility)
      request = { target: quality.requested, ...(quality.mode ? { mode: quality.mode } : {}), compatibility }
    }
  }
}
