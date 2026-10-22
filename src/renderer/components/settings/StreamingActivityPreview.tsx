import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { diagnosticQualityLabel, diagnosticWindow, type DiagnosticMapSpan, type StreamingDiagnosticsReading } from '../../utils/streamingDiagnostics'
import { ACTIVITY_SETTLE_MS, StreamActivityPresentation } from '../../utils/streamActivityPresentation'

const width = 960, top = 14, height = 72
const qualityClass = (quality: DiagnosticMapSpan['quality']) => quality ? `stream-map-quality-${quality}` : 'stream-map-neutral'
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

interface Tile {
  x: number; y: number; w: number; h: number
  fillX: number; fillY: number; fillWidth: number; fillHeight: number
  column: number; row: number; delay: number; order: number; count: number
}

/** All stages share geometry and fill motion. Direct rectangles avoid the
 * fractional viewport clipping seams produced by one nested SVG per tile. */
function ActivityTile({ tile, mode, progress = null, layer }: {
  tile: Tile
  mode: 'transfer' | 'arrival' | 'prepared' | 'bytes'
  progress?: number | null
  layer: 'fill' | 'outline'
}) {
  const fraction = progress === null ? 0 : Math.max(0, Math.min(1, progress * tile.count - tile.order))
  const scale = Math.floor(fraction * 3) / 3
  const fillClass = mode === 'transfer' ? 'stream-activity-progress'
    : mode === 'bytes' ? 'stream-activity-byte' : 'stream-activity-arrival'
  return <g className="stream-activity-tile" data-tile-column={tile.column} data-tile-row={tile.row}
    style={{ '--tile-delay': `${tile.delay}ms`, '--tile-fill': scale } as CSSProperties}>
    {layer === 'fill' && <rect className={`stream-activity-fill ${fillClass}`} x={tile.fillX} y={tile.fillY} width={tile.fillWidth} height={tile.fillHeight}
      fill="currentColor" data-cell-width={tile.w} data-cell-height={tile.h} />}
    {layer === 'outline' && (mode === 'transfer' || mode === 'arrival') && <rect
      className={mode === 'arrival' ? 'stream-activity-outline' : undefined}
      x={tile.x + .5} y={tile.y + .5} width={Math.max(0, tile.w - 1)} height={Math.max(0, tile.h - 1)}
      fill="none" stroke="currentColor" opacity={mode === 'transfer' && scale === 1 ? 0 : .55} />}
  </g>
}

/** Uses the same snapshots as the literal map. CSS animates only observed
 * arrivals/preparation/byte changes, and has no continuous animation loop. */
export default function StreamingActivityPreview({ reading }: { reading: StreamingDiagnosticsReading }) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<SVGSVGElement>(null)
  const presentation = useRef(new StreamActivityPresentation())
  const baseline = useRef(true)
  const lastReading = useRef(reading)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [visible, setVisible] = useState(false)
  const [pixels, setPixels] = useState({ xScale: 1, yScale: 1, xOrigin: 0, yOrigin: 0 })
  const [frame, setFrame] = useState(() => presentation.current.update(reading, 0, false))

  useEffect(() => {
    let intersecting = false
    const refresh = () => setVisible(intersecting && document.visibilityState !== 'hidden')
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; refresh() })
    if (host.current) observer.observe(host.current)
    document.addEventListener('visibilitychange', refresh)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  useLayoutEffect(() => {
    const now = performance.now()
    if (!visible || reducedMotion) baseline.current = true
    const next = presentation.current.update(reading, now, visible && !reducedMotion && !baseline.current)
    // After opening or returning to the view, the first fresh sample is a
    // baseline too: do not replay work that happened while nobody could see it.
    if (visible && !reducedMotion && lastReading.current !== reading) baseline.current = false
    lastReading.current = reading
    setFrame(next)
    if (!next.changes.length) return
    const remaining = Math.max(...next.changes.map(change => change.started + ACTIVITY_SETTLE_MS - now))
    const timer = setTimeout(() => setFrame(value => ({ ...value, changes: [] })), remaining)
    return () => clearTimeout(timer)
  }, [reading, visible, reducedMotion])

  const range = diagnosticWindow(reading.duration, reading.position)
  const hasRange = !!range
  useLayoutEffect(() => {
    const measure = () => {
      const matrix = plot.current?.getScreenCTM()
      if (!matrix || matrix.a <= 0 || matrix.d <= 0) return
      const dpr = window.devicePixelRatio || 1
      const next = { xScale: matrix.a * dpr, yScale: matrix.d * dpr, xOrigin: matrix.e * dpr, yOrigin: matrix.f * dpr }
      setPixels(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    if (plot.current) observer.observe(plot.current)
    measure()
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [hasRange, visible])

  // Adjacent semitransparent fills must share device-pixel edges, including at
  // fractional interface scales. Rounding each tile's width independently can
  // leave a hairline (or a darker overlap) between otherwise completed cells.
  const snapX = (value: number) => (Math.round(value * pixels.xScale + pixels.xOrigin) - pixels.xOrigin) / pixels.xScale
  const snapY = (value: number) => (Math.round(value * pixels.yScale + pixels.yOrigin) - pixels.yOrigin) / pixels.yScale
  const rawX = (seconds: number) => range ? Math.max(0, Math.min(width, (seconds - range.start) / (range.end - range.start) * width)) : 0
  const x = (seconds: number) => snapX(rawX(seconds))
  // Render settled runs as single surfaces rather than adjacent translucent
  // packets. The literal map still retains every diagnostic boundary.
  const surfaces: DiagnosticMapSpan[] = []
  for (const span of frame.spans) {
    const previous = surfaces.at(-1)
    if (previous && previous.end === span.start && previous.state === span.state && previous.quality === span.quality
      && (span.state === 'cached' || span.state === 'buffered')) previous.end = span.end
    else surfaces.push({ ...span })
  }
  const settledParts = (span: DiagnosticMapSpan) => {
    let parts = [{ start: span.start, end: span.end }]
    for (const change of frame.changes.filter(c => c.kind !== 'bytes')) {
      parts = parts.flatMap(part => change.end <= part.start || change.start >= part.end ? [part]
        : [{ start: part.start, end: Math.min(part.end, change.start) }, { start: Math.max(part.start, change.end), end: part.end }]
          .filter(part => part.end > part.start))
    }
    return parts
  }
  const tiles = (start: number, end: number) => {
    if (!range) return []
    // Anchor one grid to Stratum's four-second packets, not to the width of
    // each observed batch. The active packet and its later arrival keep the
    // same cells; only actual partial range boundaries can clip a cell.
    const packetWidth = 4 / (range.end - range.start) * width
    const cellWidth = packetWidth / Math.max(1, Math.round(packetWidth / 12))
    const rows = Math.max(1, Math.round(height / cellWidth)), cellHeight = height / rows
    const left = rawX(start), right = rawX(end)
    const first = Math.floor(left / cellWidth + 1e-8), last = Math.ceil(right / cellWidth - 1e-8)
    const cells: Tile[] = []
    for (let column = first; column < last; column++) {
      const x1 = snapX(Math.max(left, column * cellWidth)), x2 = snapX(Math.min(right, (column + 1) * cellWidth))
      for (let row = 0; row < rows; row++) {
        const y1 = snapY(top + row * cellHeight), y2 = snapY(top + (row + 1) * cellHeight)
        // Union opaque fills before applying cache opacity once to their group.
        // A small internal overlap covers SVG rasterization at fractional zoom;
        // the range's outer edges are never expanded.
        const fillX = Math.max(snapX(left), x1 - 1), fillY = Math.max(snapY(top), y1 - 1)
        cells.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, column, row,
          fillX, fillY, fillWidth: Math.min(snapX(right), x2 + 1) - fillX, fillHeight: Math.min(snapY(top + height), y2 + 1) - fillY,
          delay: ((Math.floor(column / 2) * 3 + Math.floor(row / 2) * 2) % 7) * 45 + (column % 2) * 16 + (row % 2) * 20,
          order: 0, count: (last - first) * rows })
      }
    }
    // The same clustered order drives measured progress and arrival reveals.
    cells.sort((a, b) => a.delay - b.delay || a.column - b.column || a.row - b.row)
    return cells.map((tile, order) => ({ ...tile, order }))
  }
  return <div ref={host} className={`streaming-activity-preview${!visible || reducedMotion ? ' is-still' : ''}`}>
    <div className="streaming-activity-caption"><span>Activity preview</span><span>Same data · tile transitions</span></div>
    {!range ? <p>Waiting for the track’s duration…</p> : <>
      <svg ref={plot} viewBox={`-6 0 ${width + 12} 96`} role="img" aria-label="Streaming activity preview. Brief tile transitions show confirmed arrivals and preparation; quality and ranges match the literal map.">
        <rect y={top} width={width} height={height} className="stream-map-empty" />
        {surfaces.filter(span => span.state !== 'unprepared').map(span => <g key={span.start}
          className={qualityClass(span.quality)} data-activity-state={span.state}>
          <title>{`${time(span.start)}–${time(span.end)} · ${span.quality ? diagnosticQualityLabel(span.quality) : 'Audio'} · ${span.state}${span.progress !== null ? ` · ${Math.floor(span.progress * 100)}% received` : ''}`}</title>
          {span.state === 'cached' || span.state === 'buffered'
            ? settledParts(span).map(part => <rect key={part.start} x={x(part.start)} y={top} width={x(part.end) - x(part.start)} height={height} fill="currentColor" opacity={span.state === 'cached' ? .42 : 1} />)
            : <>
              <g opacity=".8">{tiles(span.start, span.end).map(tile => <ActivityTile key={`${tile.column}:${tile.row}`}
                tile={tile} mode="transfer" progress={span.progress} layer="fill" />)}</g>
              {tiles(span.start, span.end).map(tile => <ActivityTile key={`${tile.column}:${tile.row}`}
                tile={tile} mode="transfer" progress={span.progress} layer="outline" />)}
            </>}
        </g>)}
        {frame.changes.map(change => <g key={change.id} className={qualityClass(change.quality)} data-activity-kind={change.kind}>
          {change.from === 'cached' && <rect x={x(change.start)} y={snapY(top)} width={x(change.end) - x(change.start)} height={snapY(top + height) - snapY(top)} fill="currentColor" opacity=".42" />}
          <g opacity={change.kind === 'arrival' ? .42 : change.kind === 'bytes' ? .8 : 1}>
            {tiles(change.start, change.end).map(tile => <ActivityTile key={`${tile.column}:${tile.row}`} tile={tile} mode={change.kind} layer="fill" />)}
          </g>
          {change.kind === 'arrival' && tiles(change.start, change.end).map(tile => <ActivityTile key={`${tile.column}:${tile.row}`} tile={tile} mode={change.kind} layer="outline" />)}
        </g>)}
        <rect y={top} width={x(reading.position)} height={height}
          className={`stream-map-played${frame.smoothPosition ? ' stream-activity-played' : ''}`} pointerEvents="none" />
        <g className={`stream-map-playhead${frame.smoothPosition ? ' stream-activity-playhead' : ''}`}
          style={{ transform: `translateX(${x(reading.position)}px)` }} pointerEvents="none">
          <path d="M-5 1h10v5H2v4H1v80H-1V10H-2V6H-5Z" />
        </g>
      </svg>
      <div className="stream-map-axis"><span>{time(range.start)}</span><span>{time(reading.position)} / {time(reading.duration)}</span><span>{time(range.end)}</span></div>
    </>}
  </div>
}
