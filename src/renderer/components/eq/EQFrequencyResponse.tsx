import { useCallback, useRef, useMemo } from 'react'
import { EQBand } from '../../types/audio'
import {
  computeCombinedEQMagnitude,
  isPassEQBandType,
} from '../../utils/eq'

interface EQFrequencyResponseProps {
  bands: EQBand[]
  enabled: boolean
  selectedBandIndex: number | null
  onBandDrag: (index: number, updates: Partial<EQBand>) => void
  onBandSelect: (index: number) => void
  sampleRate: number
  width: number
  height: number
}

const MIN_FREQ = 20
const MAX_FREQ = 20000
const MIN_DB = -12
const MAX_DB = 12
const DB_RANGE = MAX_DB - MIN_DB

const FREQ_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const DB_GRID = [-12, -6, 0, 6, 12]

function freqToX(freq: number, width: number): number {
  const logMin = Math.log10(MIN_FREQ)
  const logMax = Math.log10(MAX_FREQ)
  return ((Math.log10(freq) - logMin) / (logMax - logMin)) * width
}

function xToFreq(x: number, width: number): number {
  const logMin = Math.log10(MIN_FREQ)
  const logMax = Math.log10(MAX_FREQ)
  const logFreq = logMin + (x / width) * (logMax - logMin)
  return Math.pow(10, logFreq)
}

function dbToY(db: number, height: number): number {
  return ((MAX_DB - db) / DB_RANGE) * height
}

function yToDb(y: number, height: number): number {
  return MAX_DB - (y / height) * DB_RANGE
}

function formatFreq(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`
  return `${Math.round(hz)}`
}

export default function EQFrequencyResponse({
  bands,
  enabled,
  selectedBandIndex,
  onBandDrag,
  onBandSelect,
  sampleRate,
  width,
  height,
}: EQFrequencyResponseProps) {
  const draggingRef = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Compute combined frequency response curve
  const { curvePath, fillPath } = useMemo(() => {
    if (width <= 0 || height <= 0) return { curvePath: '', fillPath: '' }

    const numPoints = 200
    const points: string[] = []
    const zeroY = dbToY(0, height)

    for (let i = 0; i <= numPoints; i++) {
      const x = (i / numPoints) * width
      const freq = xToFreq(x, width)
      let totalDb = enabled ? computeCombinedEQMagnitude(bands, freq, sampleRate) : 0

      // Clamp display
      totalDb = Math.max(MIN_DB - 2, Math.min(MAX_DB + 2, totalDb))
      const y = dbToY(totalDb, height)
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }

    const curvePath = `M${points.join(' L')}`
    const fillPath = `M${(0).toFixed(1)},${zeroY.toFixed(1)} L${points.join(' L')} L${width.toFixed(1)},${zeroY.toFixed(1)} Z`
    return { curvePath, fillPath }
  }, [bands, enabled, sampleRate, width, height])

  const getSVGCoords = useCallback(
    (e: React.PointerEvent): { x: number; y: number } => {
      const svg = svgRef.current
      if (!svg) return { x: 0, y: 0 }
      const rect = svg.getBoundingClientRect()
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
    },
    []
  )

  const handlePointPointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as SVGElement).setPointerCapture(e.pointerId)
      draggingRef.current = index
      onBandSelect(index)
    },
    [onBandSelect]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (draggingRef.current === null) return
      const band = bands[draggingRef.current]
      if (!band) return
      const { x, y } = getSVGCoords(e)
      const freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(x, width)))
      if (isPassEQBandType(band.type)) {
        onBandDrag(draggingRef.current, { frequency: Math.round(freq) })
        return
      }

      const gain = Math.max(MIN_DB, Math.min(MAX_DB, yToDb(y, height)))
      onBandDrag(draggingRef.current, {
        frequency: Math.round(freq),
        gain: Math.round(gain * 10) / 10,
      })
    },
    [bands, getSVGCoords, onBandDrag, width, height]
  )

  const handlePointerUp = useCallback(() => {
    draggingRef.current = null
  }, [])

  if (width <= 0 || height <= 0) return null

  return (
    <svg
      ref={svgRef}
      className="eq-response-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Grid lines - frequencies */}
      {FREQ_GRID.map((f) => {
        const x = freqToX(f, width)
        return (
          <g key={`freq-${f}`}>
            <line x1={x} y1={0} x2={x} y2={height} className="eq-response-grid-line" />
            <text x={x} y={height - 4} className="eq-grid-label" textAnchor="middle">
              {formatFreq(f)}
            </text>
          </g>
        )
      })}

      {/* Grid lines - dB */}
      {DB_GRID.map((db) => {
        const y = dbToY(db, height)
        return (
          <g key={`db-${db}`}>
            <line
              x1={0} y1={y} x2={width} y2={y}
              className={db === 0 ? 'eq-response-zero-line' : 'eq-response-grid-line'}
            />
            <text x={4} y={y - 3} className="eq-grid-label">
              {db > 0 ? '+' : ''}{db}
            </text>
          </g>
        )
      })}

      {/* Fill under curve */}
      {fillPath && <path d={fillPath} className="eq-response-fill" />}

      {/* Curve */}
      {curvePath && <path d={curvePath} className="eq-response-curve" />}

      {/* Band control points */}
      {enabled &&
        bands.map((band, i) => {
          const passFilter = isPassEQBandType(band.type)
          const cx = freqToX(band.frequency, width)
          const pointDb = passFilter
            ? computeCombinedEQMagnitude(bands, band.frequency, sampleRate)
            : band.gain
          const cy = dbToY(Math.max(MIN_DB - 2, Math.min(MAX_DB + 2, pointDb)), height)
          return (
            <g
              key={band.id}
              className={`eq-band-point ${selectedBandIndex === i ? 'selected' : ''} ${passFilter ? 'pass-filter' : ''}`}
              onPointerDown={(e) => handlePointPointerDown(e, i)}
              style={{ touchAction: 'none' }}
            >
              {passFilter && (
                <line
                  className="eq-band-pass-guide"
                  x1={cx}
                  y1={0}
                  x2={cx}
                  y2={height}
                />
              )}
              {passFilter ? (
                <polygon
                  className="eq-band-point-shape"
                  points={`${cx},${cy - 8} ${cx + 8},${cy} ${cx},${cy + 8} ${cx - 8},${cy}`}
                />
              ) : (
                <circle
                  className="eq-band-point-shape"
                  cx={cx}
                  cy={cy}
                  r={8}
                />
              )}
            </g>
          )
        })}
    </svg>
  )
}
