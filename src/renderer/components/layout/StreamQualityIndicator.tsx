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
  // Keep a close target when an open panel follows playback onto a local track.
  if (!quality) return expanded ? <button type="button" id="streaming-activity-toggle"
    className="transport-stream-quality" aria-expanded="true" aria-controls="streaming-activity"
    onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
    onClick={onClick}>Hide stream activity</button> : null

  const original = !quality.compatibility && (quality.requested === 'original' || quality.requestedCodec === null)
  const bitrate = quality.delivered?.bitrateKbps
  const bitrateLabel = typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
    ? `${Math.round(bitrate)} kbps` : null
  const label = quality.compatibility
    ? quality.delivered?.codec
      ? [quality.delivered.codec.toUpperCase(), bitrateLabel].filter(Boolean).join(' ')
      : `${quality.compatibility.toUpperCase()} requested`
    : original ? 'Original' : bitrateLabel ?? `${quality.requested} kbps target`
  const details = `${quality.transport === 'stratum' ? 'Stratum · ' : ''}${describeRemotePlaybackQuality(quality)}`
  const from = serverName ? `From ${serverName}` : null
  const action = expanded ? 'Hide stream activity' : 'Show stream activity'

  return <button
    type="button"
    id="streaming-activity-toggle"
    className="transport-stream-quality"
    onClick={onClick}
    onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
    title={[details, from, action].filter(Boolean).join('\n')}
    aria-label={[details, from, action].filter(Boolean).join('. ')}
    aria-expanded={expanded}
    aria-controls={expanded ? 'streaming-activity' : undefined}
  >
    <span className="transport-stream-quality-mode">{quality.transport === 'stratum' ? quality.mode ? 'Stratum · Auto' : 'Stratum' : quality.compatibility ? 'Converted' : quality.mode ? 'Auto' : 'Stream'}</span>
    <span aria-hidden="true">·</span>
    <span className="transport-stream-quality-value" aria-live="polite" aria-atomic="true">{label}</span>
  </button>
}
