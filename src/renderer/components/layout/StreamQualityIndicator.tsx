import type { RemotePlaybackQuality } from '../../../types/streamingQuality'
import { describeRemotePlaybackQuality } from '../../audio/audioPipelineModel'
import { usePlayerStore } from '../../stores/playerStore'
import { useServerName } from '../settings/servers/useServers'

export default function StreamQualityIndicator({ quality, expanded, onClick }: {
  quality: RemotePlaybackQuality | undefined
  expanded: boolean
  onClick: () => void
}) {
  const source = usePlayerStore(state => state.currentTrack)
  const serverName = useServerName(source?.sourceType, source?.sourceId)
  if (!quality || (!quality.mode && !quality.compatibility)) return null

  const original = !quality.compatibility && (quality.requested === 'original' || quality.requestedCodec === null)
  const bitrate = quality.delivered?.bitrateKbps
  const bitrateLabel = typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
    ? `${Math.round(bitrate)} kbps` : null
  const label = quality.compatibility
    ? quality.delivered?.codec
      ? [quality.delivered.codec.toUpperCase(), bitrateLabel].filter(Boolean).join(' ')
      : `${quality.compatibility.toUpperCase()} requested`
    : original ? 'Original' : bitrateLabel ?? `${quality.requested} kbps target`
  const details = describeRemotePlaybackQuality(quality)
  const from = serverName ? `From ${serverName}` : null
  const action = expanded ? 'Hide audio pipeline' : 'Show audio pipeline'

  return <button
    type="button"
    className="transport-stream-quality"
    onClick={onClick}
    title={[details, from, action].filter(Boolean).join('\n')}
    aria-label={[details, from, action].filter(Boolean).join('. ')}
    aria-expanded={expanded}
  >
    <span className="transport-stream-quality-mode">{quality.compatibility ? 'Converted' : 'Auto'}</span>
    <span aria-hidden="true">·</span>
    <span className="transport-stream-quality-value" aria-live="polite" aria-atomic="true">{label}</span>
  </button>
}
