import { useId } from 'react'
import type { StreamingDiagnosticSegment } from '../../../types/streamingDiagnostics'
import { describeRemotePlaybackQuality } from '../../audio/audioPipelineModel'
import { diagnosticBufferedRange, diagnosticQualityLabel, diagnosticWindow, type StreamingDiagnosticsReading } from '../../utils/streamingDiagnostics'
import './streamingDiagnostics.css'

const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`
const bytes = (value: number | null) => value === null ? '—' : value < 1024 ? `${value} B` : value < 1024 ** 2
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`
const ms = (value: number | null) => value === null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`

function segmentDescription(segment: StreamingDiagnosticSegment) {
  return `${time(segment.start)}–${time(segment.end)} · ${diagnosticQualityLabel(segment.quality)} · ${segment.state}\n`
    + `${bytes(segment.payloadBytes ?? segment.receivedBytes)} · ${segment.state === 'decoded' ? 'ready in' : 'elapsed'} ${ms(segment.elapsedMs)}\n`
    + `Astra cache: ${segment.localCacheHit === true ? 'hit' : segment.localCacheHit === false ? 'miss' : 'not reported'}\n`
    + `Sidecar cache: ${segment.serverCacheHit === true ? 'hit' : segment.serverCacheHit === false ? 'miss' : 'not reported'}`
}

export function StreamBlockMap({ reading }: { reading: StreamingDiagnosticsReading }) {
  const id = useId().replace(/:/g, '')
  const range = diagnosticWindow(reading.duration, reading.position)
  const buffered = diagnosticBufferedRange(reading)
  if (!range) return <p>Waiting for the track’s duration…</p>
  const width = 960, top = 18, height = 46
  const x = (seconds: number) => Math.max(0, Math.min(width, (seconds - range.start) / (range.end - range.start) * width))
  const position = x(reading.position)
  const segments = reading.session?.segments.filter(segment => segment.end > range.start && segment.start < range.end) ?? []
  const stratum = reading.transport === 'stratum'
  const preparedStart = buffered ? x(buffered.start) : 0
  const preparedWidth = buffered ? Math.max(0, x(buffered.end) - preparedStart) : 0
  return <div className="streaming-block-map">
    <svg viewBox={`-6 0 ${width + 12} 76`} role="img" aria-label={`Stream map. Playing at ${time(reading.position)}. ${Math.max(0, (buffered?.end ?? reading.bufferedEnd) - reading.position).toFixed(1)} seconds buffered ahead.`}>
      <defs>
        <pattern id={`${id}-grid`} width={4 / (range.end - range.start) * width} height={height} patternUnits="userSpaceOnUse" y={top}>
          <rect width="1" height={height} className="stream-map-grid" />
        </pattern>
        <pattern id={`${id}-active`} width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="3" height="3" fill="currentColor" opacity=".4" />
        </pattern>
        <clipPath id={`${id}-buffered`}><rect x={preparedStart} y={top} width={preparedWidth} height={height} /></clipPath>
      </defs>
      <rect y={top} width={width} height={height} className="stream-map-empty"><title>Unprepared, or outside the recorded part of this session</title></rect>
      {!stratum && buffered && <rect x={preparedStart} y={top} width={preparedWidth} height={height} className="stream-map-buffered"><title>Decoded audio for this playback session</title></rect>}
      {segments.map(segment => {
        const left = x(Math.max(segment.start, reading.session?.start ?? 0)), right = x(segment.end)
        const w = Math.max(0, right - left - 1)
        if (w === 0) return null
        const active = segment.state === 'requesting' || segment.state === 'downloading'
        return <g key={segment.start} className={`stream-map-quality-${segment.quality}${active ? ' stream-map-active' : ''}`}>
          <title>{segmentDescription(segment)}</title>
          <rect x={left + .5} y={top + .5} width={w} height={height - 1} fill={active ? `url(#${id}-active)` : 'none'} stroke="currentColor" strokeWidth="1" />
          <rect x={left + 1} y={top + 1} width={Math.max(0, w - 1)} height={height - 2} fill="currentColor" clipPath={`url(#${id}-buffered)`} />
          {segment.serverCacheHit === true && w >= 6 && <path className="stream-map-cache" d={`M${left + 2} ${top + 8}v-6h4 M${right - 7} ${top + 2}h4v6 M${left + 2} ${top + height - 8}v6h4 M${right - 7} ${top + height - 2}h4v-6`} />}
          {(segment.state === 'failed' || segment.state === 'cancelled') && <path className="stream-map-failed" d={`M${left + 2} ${top + 2}L${right - 2} ${top + height - 2}`} />}
        </g>
      })}
      <rect y={top} width={width} height={height} fill={`url(#${id}-grid)`} pointerEvents="none" />
      <rect y={top} width={position} height={height} className="stream-map-played" pointerEvents="none" />
      {reading.session?.localCacheComplete && <path className="stream-map-cache" d={`M0 ${top + 12}v-12h12 M${width - 12} ${top}h12v12 M0 ${top + height - 12}v12h12 M${width - 12} ${top + height}h12v-12`} />}
      <g transform={`translate(${position} 0)`} className="stream-map-playhead" pointerEvents="none">
        <path d="M-6 2h12v6H3v4H1v58H-1V12H-3V8H-6Z" />
      </g>
    </svg>
    <div className="stream-map-axis"><span>{time(range.start)}</span><span>{time(reading.position)} / {time(reading.duration)}</span><span>{time(range.end)}</span></div>
  </div>
}

export default function StreamingDiagnosticsView({ reading }: { reading: StreamingDiagnosticsReading }) {
  const { session, next } = reading
  const stratum = reading.transport === 'stratum'
  const last = session?.segments.at(-1)
  const pending = last && ['requesting', 'downloading', 'received'].includes(last.state) ? last : null
  const ahead = Math.max(0, reading.bufferedEnd - reading.position)
  const audible = reading.quality ? describeRemotePlaybackQuality(reading.quality) : reading.transport === 'local' ? 'Local audio' : 'Not reported'
  return <div className="streaming-diagnostics-live">
    <div className="streaming-diagnostics-track"><strong>{reading.title}</strong><span>{reading.artist}</span>
      <span className="streaming-diagnostics-transport">{stratum ? 'Stratum' : reading.transport === 'local' ? 'Local' : 'Conventional stream'} · {reading.playbackState}</span>
    </div>
    <StreamBlockMap reading={reading} />
    <div className="streaming-diagnostics-legend">
      {stratum ? <><span><i className="stream-map-quality-lossless" />Original</span><span><i className="stream-map-quality-opus-128" />Opus 128</span><span><i className="stream-map-quality-opus-64" />Opus 64</span></> : <span><i className="stream-map-neutral" />Decoded</span>}
      <span><i className="stream-map-legend-outline" />{stratum ? 'Outline: requested / received' : 'Empty: not mapped'}</span>
      {stratum && <span><i className="stream-map-legend-dots" />Downloading</span>}
      <span><i className="stream-map-legend-played" />Dimmed: played</span>
      {stratum && <span><i className="stream-map-legend-cache" />Corners: Sidecar cache hit</span>}
      {session?.localCacheComplete && <span><i className="stream-map-legend-cache" />Outer frame: cached locally</span>}
    </div>
    <dl className="streaming-diagnostics-values">
      <div><dt>Hearing now</dt><dd>{audible}</dd></div>
      <div><dt>Buffered ahead</dt><dd>{reading.completeLocalBuffer ? 'Whole track' : `${ahead.toFixed(1)} s`}</dd></div>
      <div><dt>{pending ? 'Preparing' : 'Last prepared'}</dt><dd>{last ? `${diagnosticQualityLabel(last.quality)} · ${time(last.start)}–${time(last.end)}${pending ? ` · ${last.state}` : ''}` : '—'}</dd></div>
      <div><dt>{stratum ? 'Audio received' : 'File bytes available'}</dt><dd>{bytes(reading.loadedBytes)}{reading.totalBytes !== null ? ` / ${bytes(reading.totalBytes)}` : ''}</dd></div>
      {session && <div><dt>Output PCM</dt><dd>{session.outputRate / 1000} kHz · {session.channels} ch{session.sourceRate ? ` · source ${session.sourceRate / 1000} kHz` : ''}</dd></div>}
      <div><dt>Next track</dt><dd>{next ? `${next.transport === 'stratum' ? 'Stratum' : next.transport === 'local' ? 'Local' : 'Conventional'} · ${Math.max(0, next.bufferedEnd - next.start).toFixed(1)} s prepared` : 'No progressive stream staged'}</dd></div>
    </dl>
    {stratum && !!session?.segments.length && <details className="streaming-diagnostics-details">
      <summary>Recent segments · {session.segments.filter(segment => segment.localCacheHit === true).length} Astra hits · {session.segments.filter(segment => segment.serverCacheHit === true).length} Sidecar hits{session.omittedSegments ? ` · ${session.omittedSegments} earlier segments omitted` : ''}</summary>
      <div className="streaming-diagnostics-table-scroll"><table>
        <thead><tr><th>Track time</th><th>Quality</th><th>State</th><th>Ready in</th><th>Body transfer</th><th>Decode</th><th>Astra cache</th><th>Sidecar cache</th></tr></thead>
        <tbody>{session.segments.slice(-8).reverse().map(segment => <tr key={segment.start}>
          <td>{time(segment.start)}–{time(segment.end)}</td><td>{diagnosticQualityLabel(segment.quality)}</td><td>{segment.state}</td>
          <td>{segment.state === 'decoded' ? ms(segment.elapsedMs) : '—'}</td><td>{ms(segment.transferMs)}</td><td>{ms(segment.decodeMs)}</td>
          <td>{segment.localCacheHit === true ? 'Hit' : segment.localCacheHit === false ? 'Miss' : '—'}</td>
          <td>{segment.serverCacheHit === true ? 'Hit' : segment.serverCacheHit === false ? 'Miss' : 'Not reported'}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
    <p className="streaming-diagnostics-note">{stratum
      ? 'Filled blocks have reached the playback buffer. Empty areas are unprepared or outside this session’s recorded range. Opus labels are bitrate targets.'
      : 'The map shows decoded audio for this playback session. Partial file downloads cannot be mapped accurately to track time.'}</p>
    <p className="streaming-diagnostics-note">Live at 2 updates/s while visible. No extra audio requests. Nothing is written to disk.</p>
  </div>
}
