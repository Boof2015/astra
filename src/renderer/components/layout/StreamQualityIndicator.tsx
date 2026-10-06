import type { RemotePlaybackQuality } from '../../../types/streamingQuality'
import { describeRemotePlaybackQuality } from '../../audio/audioPipelineModel'

export default function StreamQualityIndicator({ quality, expanded, onClick }: {
  quality: RemotePlaybackQuality | undefined
  expanded: boolean
  onClick: () => void
}) {
  if (!quality?.mode) return null

  const original = quality.requested === 'original' || quality.requestedCodec === null
  const bitrate = quality.delivered?.bitrateKbps
  const label = original ? 'Original'
    : typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
      ? `${Math.round(bitrate)} kbps`
      : `${quality.requested} kbps target`
  const details = describeRemotePlaybackQuality(quality)
  const action = expanded ? 'Hide audio pipeline' : 'Show audio pipeline'

  return <button
    type="button"
    className="transport-stream-quality"
    onClick={onClick}
    title={`${details}\n${action}`}
    aria-label={`${details}. ${action}`}
    aria-expanded={expanded}
  >
    <span className="transport-stream-quality-mode">Auto</span>
    <span aria-hidden="true">·</span>
    <span className="transport-stream-quality-value" aria-live="polite" aria-atomic="true">{label}</span>
  </button>
}
