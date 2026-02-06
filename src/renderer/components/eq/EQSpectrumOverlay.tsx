import { useRef, useEffect } from 'react'
import { audioEngine } from '../../audio/AudioEngine'

const MIN_FREQ = 20
const MAX_FREQ = 20000
const LOG_MIN = Math.log10(MIN_FREQ)
const LOG_MAX = Math.log10(MAX_FREQ)

// Spectrum dB range
const SPEC_MIN_DB = -90
const SPEC_MAX_DB = -10
const SPEC_DB_RANGE = SPEC_MAX_DB - SPEC_MIN_DB

interface EQSpectrumOverlayProps {
  width: number
  height: number
}

function frequencyAtX(x: number, width: number): number {
  const logFreq = LOG_MIN + (x / width) * (LOG_MAX - LOG_MIN)
  return Math.pow(10, logFreq)
}

export default function EQSpectrumOverlay({ width, height }: EQSpectrumOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animIdRef = useRef<number | null>(null)
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null)

  useEffect(() => {
    if (width <= 0 || height <= 0) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas resolution to match CSS size
    canvas.width = width * window.devicePixelRatio
    canvas.height = height * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      const analyser = audioEngine.getEQAnalyserNode()
      if (!analyser || audioEngine.playbackState !== 'playing') {
        animIdRef.current = requestAnimationFrame(draw)
        return
      }

      // Allocate/reuse Float32Array for frequency data
      const binCount = analyser.frequencyBinCount
      if (!dataRef.current || dataRef.current.length !== binCount) {
        dataRef.current = new Float32Array(binCount)
      }
      analyser.getFloatFrequencyData(dataRef.current)

      const sampleRate = audioEngine.getSampleRate()
      const nyquist = sampleRate / 2
      const binWidth = nyquist / binCount

      // Build points: one per pixel column
      const numPoints = Math.max(2, Math.floor(width))
      ctx.beginPath()

      for (let i = 0; i < numPoints; i++) {
        const x = i
        const freq = frequencyAtX(x, width)

        // Find the FFT bin(s) for this frequency
        const bin = freq / binWidth
        const binLow = Math.floor(bin)
        const binHigh = Math.min(binLow + 1, binCount - 1)
        const frac = bin - binLow

        // Interpolate between adjacent bins
        const dbLow = dataRef.current[binLow] ?? SPEC_MIN_DB
        const dbHigh = dataRef.current[binHigh] ?? SPEC_MIN_DB
        const db = dbLow + (dbHigh - dbLow) * frac

        // Map dB to Y position
        const normalized = (db - SPEC_MIN_DB) / SPEC_DB_RANGE
        const y = height - Math.max(0, Math.min(1, normalized)) * height

        if (i === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      }

      // Close the fill path
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()

      // Gradient fill: transparent at bottom, accent-tinted at top
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, 'rgba(139, 92, 246, 0)')
      gradient.addColorStop(0.4, 'rgba(139, 92, 246, 0.06)')
      gradient.addColorStop(0.7, 'rgba(139, 92, 246, 0.12)')
      gradient.addColorStop(1, 'rgba(139, 92, 246, 0.18)')
      ctx.fillStyle = gradient
      ctx.fill()

      animIdRef.current = requestAnimationFrame(draw)
    }

    animIdRef.current = requestAnimationFrame(draw)

    return () => {
      if (animIdRef.current !== null) {
        cancelAnimationFrame(animIdRef.current)
        animIdRef.current = null
      }
    }
  }, [width, height])

  if (width <= 0 || height <= 0) return null

  return (
    <canvas
      ref={canvasRef}
      className="eq-spectrum-canvas"
      style={{ width, height }}
    />
  )
}
