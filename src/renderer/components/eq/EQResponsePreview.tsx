import { useMemo } from 'react'
import { useEQStore } from '../../stores/eqStore'
import { backendManager as audioEngine } from '../../audio/AudioBackendManager'
import type { EQBand } from '../../types/audio'

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

function computeFilterMagnitude(band: EQBand, testFreq: number, sampleRate: number): number {
  const w0 = (2 * Math.PI * band.frequency) / sampleRate
  const w = (2 * Math.PI * testFreq) / sampleRate
  const A = Math.pow(10, band.gain / 40)
  const sinW0 = Math.sin(w0)
  const cosW0 = Math.cos(w0)
  const alpha = sinW0 / (2 * band.Q)

  let b0: number
  let b1: number
  let b2: number
  let a0: number
  let a1: number
  let a2: number

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

export default function EQResponsePreview({
  className = '',
  width = 120,
  height = 36,
  showBaseline = true,
  showFill = true,
}: EQResponsePreviewProps) {
  const bands = useEQStore((s) => s.bands)
  const preamp = useEQStore((s) => s.preamp)
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
      let totalDb = 0

      if (enabled) {
        for (const band of bands) {
          totalDb += computeFilterMagnitude(band, freq, sampleRate)
        }
      }

      totalDb = Math.max(MIN_DB, Math.min(MAX_DB, totalDb))
      const y = dbToY(totalDb, height)
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }

    const curve = `M${points.join(' L')}`
    const fill = `M0,${zeroY.toFixed(2)} L${points.join(' L')} L${width.toFixed(2)},${zeroY.toFixed(2)} Z`
    return { curvePath: curve, fillPath: fill, baselineY: zeroY }
  }, [bands, preamp, enabled, sampleRate, width, height])

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
