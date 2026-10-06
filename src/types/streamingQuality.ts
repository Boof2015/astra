/** Manual values are server bitrate targets, never measurements of the response. */
export const STREAMING_BITRATES = [64, 128, 192, 256, 320] as const
export type StreamQualityTarget = 'original' | typeof STREAMING_BITRATES[number]
export type AutomaticStreamingQuality = 'automatic' | 'automatic-original'
export type StreamingQuality = StreamQualityTarget | AutomaticStreamingQuality
/** Pin the current representation without losing the automatic mode on seeks. */
export type StreamingQualityRequest = StreamingQuality | { mode: AutomaticStreamingQuality; target: StreamQualityTarget }
export interface StreamingQualitySource { provider: 'subsonic' | 'jellyfin'; sourceId: number }
export interface StreamingQualitySettings {
  global: StreamingQuality
  overrides: Record<string, StreamingQuality>
}
export interface DeliveredAudioFormat {
  codec: string | null
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
  bitrateKbps: number | null
}
export interface RemotePlaybackQuality {
  analysisKey?: string
  /** Snapshot at acquisition; a scan finishing mid-play never changes gain. */
  loudness?: import('./remoteAudioAnalysis').RemoteAudioLoudness | null
  requested: StreamQualityTarget
  mode?: AutomaticStreamingQuality
  /** Preferred server encoder; servers may decline or ignore this request. */
  requestedCodec: 'mp3' | null
  delivered: DeliveredAudioFormat | null
}

export function isStreamingQuality(value: unknown): value is StreamingQuality {
  return isStreamQualityTarget(value) || isAutomaticStreamingQuality(value)
}

export function isStreamQualityTarget(value: unknown): value is StreamQualityTarget {
  return value === 'original' || STREAMING_BITRATES.some(bitrate => bitrate === value)
}

export function isAutomaticStreamingQuality(value: unknown): value is AutomaticStreamingQuality {
  return value === 'automatic' || value === 'automatic-original'
}

export function isStreamingQualityRequest(value: unknown): value is StreamingQualityRequest {
  if (isStreamingQuality(value)) return true
  const request = value as { mode?: unknown; target?: unknown } | null
  return !!request && isAutomaticStreamingQuality(request.mode) && isStreamQualityTarget(request.target)
}

export function playbackQualityRequest(quality: RemotePlaybackQuality | undefined): StreamingQualityRequest | undefined {
  return quality?.mode ? { mode: quality.mode, target: quality.requested } : quality?.requested
}

export function streamingQualityLabel(quality: StreamingQuality): string {
  return quality === 'automatic' ? 'Automatic' : quality === 'automatic-original' ? 'Automatic (prioritize original)'
    : quality === 'original' ? 'Original' : `${quality} kbps`
}

export interface AutomaticQualityPlayback {
  path: string
  quality: RemotePlaybackQuality
  position: number
  bufferedSeconds: number
  loadedBytes: number
  totalBytes: number | null
  complete: boolean
}

export function streamingQualitySourceKey(source: StreamingQualitySource): string {
  if (!source || (source.provider !== 'subsonic' && source.provider !== 'jellyfin')
    || !Number.isSafeInteger(source.sourceId) || source.sourceId <= 0) throw new Error('Invalid streaming server.')
  return `${source.provider}:${source.sourceId}`
}

export function parseStreamingQualitySettings(serialized: string | null | undefined): StreamingQualitySettings {
  const defaults: StreamingQualitySettings = { global: 'original', overrides: {} }
  try {
    const value = JSON.parse(serialized ?? '')
    if (!value || typeof value !== 'object') return defaults
    const overrides: Record<string, StreamingQuality> = {}
    for (const [key, quality] of Object.entries(value.overrides ?? {})) {
      if (/^(subsonic|jellyfin):[1-9]\d*$/.test(key) && isStreamingQuality(quality)) overrides[key] = quality
    }
    return { global: isStreamingQuality(value.global) ? value.global : 'original', overrides }
  } catch { return defaults }
}

export function resolveStreamingQuality(settings: StreamingQualitySettings, source: StreamingQualitySource): StreamingQuality {
  return settings.overrides[streamingQualitySourceKey(source)] ?? settings.global
}

export function streamingQualitySourceFromPath(path: string): StreamingQualitySource | null {
  const match = /^(subsonic|jellyfin):\/\/([1-9]\d*)\//.exec(path)
  const sourceId = Number(match?.[2])
  return match && Number.isSafeInteger(sourceId) ? { provider: match[1] as StreamingQualitySource['provider'], sourceId } : null
}

export function streamingRepresentation(quality: StreamQualityTarget): string {
  // Keep the existing original key so upgrading does not invalidate retained audio.
  return quality === 'original' ? 'original' : `mp3:${quality}:v1`
}

/** Avoid another lossy encode when the existing lossy file is already below the target. */
export function qualityRequestForTrack(quality: StreamQualityTarget, track: { codec?: string | null; format?: string | null; bitrate?: number | null } | null): StreamQualityTarget {
  const codec = (track?.codec || track?.format || '').toLowerCase()
  const bitrate = track?.bitrate
  if (quality !== 'original' && typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0 && bitrate <= quality
    && ['mp3', 'aac', 'opus', 'vorbis', 'ogg', 'wma', 'wmav2'].includes(codec)) return 'original'
  return quality
}

export function deliveredAudioFormat(payload: { streams?: Array<{
  codec_type?: unknown; codec_name?: unknown; sample_rate?: unknown; channels?: unknown;
  bits_per_raw_sample?: unknown; bits_per_sample?: unknown; bit_rate?: unknown
}> }): DeliveredAudioFormat | null {
  const stream = payload.streams?.find(value => value.codec_type === 'audio')
  if (!stream) return null
  const positive = (value: unknown): number | null => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
  return {
    codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
    sampleRate: positive(stream.sample_rate), channels: positive(stream.channels),
    bitDepth: positive(stream.bits_per_raw_sample) ?? positive(stream.bits_per_sample),
    bitrateKbps: positive(stream.bit_rate) === null ? null : Number(stream.bit_rate) / 1000
  }
}
