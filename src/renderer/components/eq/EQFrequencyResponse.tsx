import { useCallback, useRef, useMemo } from 'react'
import { EQBand } from '../../types/audio'

interface EQFrequencyResponseProps {
  bands: EQBand[]
  preamp: number
  enabled: boolean
  selectedBandIndex: number | null
  onBandDrag: (index: number, freq: number, gain: number) => void
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

/**
 * Compute the magnitude response (in dB) of a single biquad filter at a test frequency.
 * Uses standard audio EQ cookbook formulas.
 */
function computeFilterMagnitude(band: EQBand, testFreq: number, sampleRate: number): number {
  const w0 = (2 * Math.PI * band.frequency) / sampleRate
  const w = (2 * Math.PI * testFreq) / sampleRate
  const A = Math.pow(10, band.gain / 40)
  const sinW0 = Math.sin(w0)
  const cosW0 = Math.cos(w0)
  const alpha = sinW0 / (2 * band.Q)

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number

  switch (band.type) {
    case 'peaking':
      b0 = 1 + alpha * A
      b1 = -2 * cosW0
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW0
      a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * ((A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0)
      b2 = A * ((A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = (A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = -2 * ((A - 1) + (A + 1) * cosW0)
      a2 = (A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * ((A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0)
      b2 = A * ((A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = (A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = 2 * ((A - 1) - (A + 1) * cosW0)
      a2 = (A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
  }

  // Evaluate H(e^jw) magnitude
  const cosW = Math.cos(w)
  const sinW = Math.sin(w)
  const cos2W = Math.cos(2 * w)
  const sin2W = Math.sin(2 * w)

  const numReal = b0 / a0 + (b1 / a0) * cosW + (b2 / a0) * cos2W
  const numImag = -(b1 / a0) * sinW - (b2 / a0) * sin2W
  const denReal = 1 + (a1 / a0) * cosW + (a2 / a0) * cos2W
  const denImag = -(a1 / a0) * sinW - (a2 / a0) * sin2W

  const numMag = Math.sqrt(numReal * numReal + numImag * numImag)
  const denMag = Math.sqrt(denReal * denReal + denImag * denImag)

  return 20 * Math.log10(numMag / (denMag + 1e-20))
}

export default function EQFrequencyResponse({
  bands,
  preamp,
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
      let totalDb = 0

      if (enabled) {
        for (const band of bands) {
          totalDb += computeFilterMagnitude(band, freq, sampleRate)
        }
      }

      // Clamp display
      totalDb = Math.max(MIN_DB - 2, Math.min(MAX_DB + 2, totalDb))
      const y = dbToY(totalDb, height)
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }

    const curvePath = `M${points.join(' L')}`
    const fillPath = `M${(0).toFixed(1)},${zeroY.toFixed(1)} L${points.join(' L')} L${width.toFixed(1)},${zeroY.toFixed(1)} Z`
    return { curvePath, fillPath }
  }, [bands, preamp, enabled, sampleRate, width, height])

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
      ;(e.target as SVGElement).setPointerCapture(e.pointerId)
      draggingRef.current = index
      onBandSelect(index)
    },
    [onBandSelect]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (draggingRef.current === null) return
      const { x, y } = getSVGCoords(e)
      const freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(x, width)))
      const gain = Math.max(MIN_DB, Math.min(MAX_DB, yToDb(y, height)))
      onBandDrag(draggingRef.current, Math.round(freq), Math.round(gain * 10) / 10)
    },
    [getSVGCoords, onBandDrag, width, height]
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
          const cx = freqToX(band.frequency, width)
          const cy = dbToY(band.gain, height)
          return (
            <circle
              key={band.id}
              cx={cx}
              cy={cy}
              className={`eq-band-point ${selectedBandIndex === i ? 'selected' : ''}`}
              onPointerDown={(e) => handlePointPointerDown(e, i)}
              style={{ touchAction: 'none' }}
            />
          )
        })}
    </svg>
  )
}
