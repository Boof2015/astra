import { useMemo } from 'react'
import { useEQStore } from '../../stores/eqStore'
import { audioEngine } from '../../audio/AudioEngine'
import { computeCombinedEQMagnitude } from '../../utils/eq'

interface EQResponsePreviewProps {
  className?: string
  width?: number
  height?: number
  showBaseline?: boolean
  showFill?: boolean
}

const MIN_FREQ = 20
const MAX_FREQ = 20000
const MIN_DB = -12
const MAX_DB = 12
const DB_RANGE = MAX_DB - MIN_DB

function dbToY(db: number, height: number): number {
  return ((MAX_DB - db) / DB_RANGE) * height
}

function xToFreq(x: number, width: number): number {
  const logMin = Math.log10(MIN_FREQ)
  const logMax = Math.log10(MAX_FREQ)
  const logFreq = logMin + (x / width) * (logMax - logMin)
  return Math.pow(10, logFreq)
}

export default function EQResponsePreview({
  className = '',
  width = 120,
  height = 36,
  showBaseline = true,
  showFill = true,
}: EQResponsePreviewProps) {
  const bands = useEQStore((s) => s.bands)
  const enabled = useEQStore((s) => s.enabled)
  const sampleRate = Math.max(22050, audioEngine.getSampleRate() || 48000)

  const { curvePath, fillPath, baselineY } = useMemo(() => {
    if (width <= 0 || height <= 0) {
      return { curvePath: '', fillPath: '', baselineY: height / 2 }
    }

    const pointCount = Math.max(32, Math.floor(width * 1.1))
    const points: string[] = []
    const zeroY = dbToY(0, height)

    for (let i = 0; i <= pointCount; i++) {
      const x = (i / pointCount) * width
      const freq = xToFreq(x, width)
      let totalDb = enabled ? computeCombinedEQMagnitude(bands, freq, sampleRate) : 0

      totalDb = Math.max(MIN_DB, Math.min(MAX_DB, totalDb))
      const y = dbToY(totalDb, height)
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }

    const curve = `M${points.join(' L')}`
    const fill = `M0,${zeroY.toFixed(2)} L${points.join(' L')} L${width.toFixed(2)},${zeroY.toFixed(2)} Z`
    return { curvePath: curve, fillPath: fill, baselineY: zeroY }
  }, [bands, enabled, sampleRate, width, height])

  return (
    <svg
      className={`eq-response-preview ${className}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {showBaseline && (
        <line
          x1={0}
          y1={baselineY}
          x2={width}
          y2={baselineY}
          className="eq-response-preview-baseline"
        />
      )}
      {showFill && fillPath && (
        <path
          d={fillPath}
          className={`eq-response-preview-fill ${enabled ? 'enabled' : 'disabled'}`}
        />
      )}
      {curvePath && (
        <path
          d={curvePath}
          className={`eq-response-preview-curve ${enabled ? 'enabled' : 'disabled'}`}
        />
      )}
    </svg>
  )
}
