import type { RemotePlaybackQuality } from '../../../types/streamingQuality'
import { describeRemotePlaybackQuality } from '../../audio/audioPipelineModel'
import { useStreamingDiagnostics } from '../../hooks/useStreamingDiagnostics'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import type { StreamingDiagnosticsReading } from '../../utils/streamingDiagnostics'
import StreamingActivityPreview, { StreamingActivityPlaceholder } from '../settings/StreamingActivityPreview'
import '../settings/streamingDiagnostics.css'
import './streamingActivityShelf.css'

function qualityLabel(quality: RemotePlaybackQuality | undefined): string {
  if (!quality) return ''
  if (!quality.compatibility && (quality.requested === 'original' || quality.requestedCodec === null)) return 'Original'
  const delivered = quality.delivered
  if (!delivered?.codec) return quality.compatibility
    ? `${quality.compatibility.toUpperCase()} requested` : `${quality.requested} kbps target`
  return [delivered.codec.toUpperCase(), delivered.bitrateKbps ? `${Math.round(delivered.bitrateKbps)} kbps` : null].filter(Boolean).join(' ')
}

function StreamingActivityStatus({ reading }: { reading: StreamingDiagnosticsReading }) {
  const buffered = Math.max(0, reading.bufferedEnd - reading.position)
  const bufferLabel = buffered >= 60 ? `${Math.floor(buffered / 60)}m ${Math.floor(buffered % 60)}s` : `${Math.floor(buffered)}s`
  return <div className="streaming-shelf-status">
      <span title={reading.quality ? describeRemotePlaybackQuality(reading.quality) : undefined}>
        {[reading.transport === 'stratum' ? 'Stratum' : 'Stream', qualityLabel(reading.quality)].filter(Boolean).join(' · ')}
      </span>
      <span>{reading.playbackState === 'buffering' ? 'Buffering · ' : reading.playbackState === 'paused' ? 'Paused · ' : ''}{bufferLabel} prepared ahead</span>
    </div>
}

export function StreamingActivityView({ reading, message, failed = false }: {
  reading: StreamingDiagnosticsReading | null; message?: string; failed?: boolean
}) {
  const ready = !failed && reading && reading.transport !== 'local' && Number.isFinite(reading.duration) && reading.duration > 0
  const stratum = reading?.transport === 'stratum'
  const note = !stratum ? 'Prepared audio is shown on the bar. Partial file downloads aren’t mapped to track time.' : undefined
  return <>
    {ready ? <StreamingActivityPreview reading={reading} showCaption={false} compact />
      : <StreamingActivityPlaceholder failed={failed} message={message ?? (reading?.transport === 'local' ? 'Playing from a local file.' : 'Waiting for the track’s duration…')} />}
    <div className={`streaming-diagnostics-legend${!ready ? ' streaming-shelf-legend-pending' : ''}`}
      aria-hidden={!ready || undefined} role="group" aria-label={note ?? 'Map key'} title={note}>
      {stratum && <><span><i className="stream-map-quality-lossless" />Original</span><span><i className="stream-map-quality-opus-128" />Opus</span>
        <span><i className="stream-map-legend-download" />Downloading</span></>}
      <span title="Soft fill · stored in Astra"><i className="stream-map-legend-soft" />Cached</span>
      <span title="Solid fill · ready for playback"><i />Prepared</span><span><i className="stream-map-legend-played" />Played</span>
      <span><i className="stream-map-legend-empty" />Unprepared</span>
    </div>
  </>
}

export default function StreamingActivityShelf() {
  const open = useUIStore(state => state.showStreamingShelf)
  const fullscreen = useUIStore(state => state.isFullscreen)
  const close = useUIStore(state => state.closeStreamingShelf)
  const track = usePlayerStore(state => state.currentTrack)
  const { reading, failed } = useStreamingDiagnostics(open && !fullscreen)
  if (!open || fullscreen) return null
  // A track change reaches the store before the next sampled reading does.
  const current = reading?.trackKey === track?.path ? reading : null
  const dismiss = () => {
    // Restore focus only for an explicit close, never when switching shelves.
    document.getElementById('streaming-activity-toggle')?.focus()
    close()
  }
  return <section id="streaming-activity" className="streaming-activity-shelf" aria-labelledby="streaming-activity-heading"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); dismiss() }
    }}>
    <div className="streaming-shelf-heading">
      <h2 id="streaming-activity-heading" title={track ? `${track.title} · ${track.artist}` : undefined}>Stream activity</h2>
      {current && !failed && current.transport !== 'local' && <StreamingActivityStatus reading={current} />}
      <button type="button" className="streaming-shelf-close" aria-label="Close stream activity" title="Close stream activity"
        onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }} onClick={dismiss}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3 3 8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    </div>
    <StreamingActivityView reading={current} failed={failed} message={failed
      ? 'Activity is temporarily unavailable. Retrying…'
      : !current ? track ? 'Waiting for playback…' : 'Play a track to see its stream.' : undefined} />
  </section>
}
