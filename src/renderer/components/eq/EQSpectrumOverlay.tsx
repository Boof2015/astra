import { useRef, useEffect } from 'react'
import {
  getEQAnalyzerFrameSnapshot,
  subscribeToEQAnalyzerFrames,
} from '../../audio/eqAnalyzerFrameSource'
import { colorToRgbChannels } from '../visualizers/ambientSpectrumMath'

const MIN_FREQ = 20
const MAX_FREQ = 20000
const LOG_MIN = Math.log10(MIN_FREQ)
const LOG_MAX = Math.log10(MAX_FREQ)

// Spectrum dB range
const SPEC_MIN_DB = -90
const SPEC_MAX_DB = -10
const SPEC_DB_RANGE = SPEC_MAX_DB - SPEC_MIN_DB
const DEFAULT_ACCENT_HEX = '#38bdf8'
const DEFAULT_ACCENT_CHANNELS = '56, 189, 248'

interface EQSpectrumOverlayProps {
  width: number
  height: number
}

function frequencyAtX(x: number, width: number): number {
  const logFreq = LOG_MIN + (x / width) * (LOG_MAX - LOG_MIN)
  return Math.pow(10, logFreq)
}

function normalizeAccentRgbChannels(value: string): string | null {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length !== 3) return null

  const channels = parts.map((part) => Number(part))
  if (channels.some((channel) => !Number.isFinite(channel))) return null

  const clamped = channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel))))
  return `${clamped[0]}, ${clamped[1]}, ${clamped[2]}`
}

function resolveAccentRgbChannels(): string {
  const styles = window.getComputedStyle(document.documentElement)

  const accentRgbToken = styles.getPropertyValue('--accent-rgb').trim()
  const accentRgbChannels = normalizeAccentRgbChannels(accentRgbToken)
  if (accentRgbChannels) return accentRgbChannels

  const accentToken = styles.getPropertyValue('--accent').trim()
  const accentChannelsFromColor = colorToRgbChannels(accentToken)
  if (accentChannelsFromColor) return accentChannelsFromColor

  return colorToRgbChannels(DEFAULT_ACCENT_HEX) ?? DEFAULT_ACCENT_CHANNELS
}

export default function EQSpectrumOverlay({ width, height }: EQSpectrumOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

      const snapshot = getEQAnalyzerFrameSnapshot()
      const frequencyData = snapshot.data
      if (!snapshot.available || !frequencyData || frequencyData.length === 0) {
        return
      }

      const binCount = frequencyData.length
      const sampleRate = snapshot.sampleRate
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
        const dbLow = frequencyData[binLow] ?? SPEC_MIN_DB
        const dbHigh = frequencyData[binHigh] ?? SPEC_MIN_DB
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
      const accentRgbChannels = resolveAccentRgbChannels()
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, `rgba(${accentRgbChannels}, 0)`)
      gradient.addColorStop(0.4, `rgba(${accentRgbChannels}, 0.06)`)
      gradient.addColorStop(0.7, `rgba(${accentRgbChannels}, 0.12)`)
      gradient.addColorStop(1, `rgba(${accentRgbChannels}, 0.18)`)
      ctx.fillStyle = gradient
      ctx.fill()
    }

    draw()
    const unsubscribe = subscribeToEQAnalyzerFrames(draw)

    return () => {
      unsubscribe()
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
