import { describeRemotePlaybackQuality } from '../../audio/audioPipelineModel'
import { diagnosticMapSpans, diagnosticQualityLabel, diagnosticWindow, type StreamingDiagnosticsReading } from '../../utils/streamingDiagnostics'
import './streamingDiagnostics.css'
import StreamingActivityPreview from './StreamingActivityPreview'

const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`
const bytes = (value: number | null) => value === null ? '—' : value < 1024 ? `${value} B` : value < 1024 ** 2
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`
const ms = (value: number | null) => value === null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`

export function StreamBlockMap({ reading }: { reading: StreamingDiagnosticsReading }) {
  const range = diagnosticWindow(reading.duration, reading.position)
  if (!range) return <p>Waiting for the track’s duration…</p>
  const width = 960, top = 14, height = 72
  const x = (seconds: number) => Math.max(0, Math.min(width, (seconds - range.start) / (range.end - range.start) * width))
  const position = x(reading.position)
  const spans = diagnosticMapSpans(reading)
  return <div className="streaming-block-map">
    <svg viewBox={`-6 0 ${width + 12} 96`} role="img" aria-label={`Stream activity. Playing at ${time(reading.position)}. ${Math.max(0, reading.bufferedEnd - reading.position).toFixed(1)} seconds buffered ahead. Soft fill is cached in Astra; solid fill is prepared for playback.`}>
      <rect y={top} width={width} height={height} className="stream-map-empty"><title>Unprepared</title></rect>
      {spans.filter(span => span.state !== 'unprepared').map(span => {
        const left = x(span.start), w = x(span.end) - left
        const active = span.state === 'downloading' || span.state === 'waiting'
        // Small pieces inside the *actual requested interval*. Their stepped
        // infill represents packet bytes; it does not invent playable ranges.
        const columns = Math.max(1, Math.ceil(w / 12)), rows = 6
        const label = span.quality ? diagnosticQualityLabel(span.quality) : reading.transport === 'stratum' ? 'Quality not recorded' : 'Audio'
        return <g key={span.start} data-state={span.state} className={span.quality ? `stream-map-quality-${span.quality}` : 'stream-map-neutral'}>
          <title>{`${time(span.start)}–${time(span.end)} · ${label} · ${span.state}${span.progress !== null ? ` · ${Math.floor(span.progress * 100)}% received` : ''}${span.qualities.length > 1 ? `\nCached versions: ${span.qualities.map(diagnosticQualityLabel).join(', ')}` : ''}`}</title>
          {!active ? <rect x={left} y={top} width={w} height={height} fill="currentColor" opacity={span.state === 'cached' ? .42 : 1} />
            : Array.from({ length: columns * rows }, (_, index) => {
              const row = Math.floor(index / columns), col = index % columns
              const cw = w / columns, ch = height / rows
              const tileX = left + col * cw, tileY = top + row * ch
              // Stable row order makes the packet arrive as a patchwork instead
              // of a second left-to-right progress bar. No timers or randomness.
              const order = ((row * 5 + col * 7) % rows) * columns + col
              const fraction = span.progress === null ? 0 : Math.max(0, Math.min(1, span.progress * columns * rows - order))
              const fillHeight = Math.floor(fraction * 3) / 3 * (ch - 4)
              return <g key={index}>
                <rect x={tileX + .5} y={tileY + .5} width={Math.max(0, cw - 1)} height={ch - 1} fill="none" stroke="currentColor" opacity=".55" />
                {fillHeight > 0 && <rect x={tileX + 2} y={tileY + ch - 2 - fillHeight} width={Math.max(0, cw - 4)} height={fillHeight} fill="currentColor" opacity=".8" />}
              </g>
            })}
        </g>
      })}
      <rect y={top} width={position} height={height} className="stream-map-played" pointerEvents="none" />
      <g transform={`translate(${position} 0)`} className="stream-map-playhead" pointerEvents="none">
        <path d="M-5 1h10v5H2v4H1v80H-1V10H-2V6H-5Z" />
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
    {stratum && <div className="streaming-activity-caption"><span>Literal map</span></div>}
    <StreamBlockMap reading={reading} />
    {stratum && <StreamingActivityPreview reading={reading} />}
    <div className="streaming-diagnostics-legend">
      {stratum ? <><span><i className="stream-map-quality-lossless" />Original</span><span><i className="stream-map-quality-opus-128" />Opus</span></> : <span><i className="stream-map-neutral" />Audio</span>}
      {stratum && <span><i className="stream-map-legend-download" />Downloading</span>}
      <span><i className="stream-map-legend-soft" />Cached</span>
      <span><i />Prepared</span>
      <span><i className="stream-map-legend-played" />Played</span>
      <span><i className="stream-map-legend-empty" />Unprepared</span>
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
      ? 'Cached means retained in Astra, including earlier visits. Downloading tiles show packet progress, not playable audio. Hover for quality and range.'
      : 'The map shows decoded audio for this playback session. Partial file downloads cannot be mapped accurately to track time.'}</p>
    <p className="streaming-diagnostics-note">Live at 2 updates/s while visible. No extra audio requests. Nothing is written to disk.</p>
  </div>
}
