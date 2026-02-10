import { useEffect, useRef, useCallback } from 'react'
import { audioEngine } from '../../audio/AudioEngine'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'

export interface FullscreenAmbientSpectrumProps {
  className?: string
  opacityIntent?: 'subtle' | 'soft'
}

function colorWithAlpha(color: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha))

  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const normalized = hex.length === 3
      ? hex.split('').map((ch) => `${ch}${ch}`).join('')
      : hex

    if (normalized.length === 6) {
      const r = parseInt(normalized.slice(0, 2), 16)
      const g = parseInt(normalized.slice(2, 4), 16)
      const b = parseInt(normalized.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`
    }
  }

  if (color.startsWith('rgb(')) {
    const values = color.slice(4, -1)
    return `rgba(${values}, ${safeAlpha})`
  }

  if (color.startsWith('rgba(')) {
    const values = color.slice(5, -1).split(',').slice(0, 3).join(',')
    return `rgba(${values}, ${safeAlpha})`
  }

  return `rgba(56, 189, 248, ${safeAlpha})`
}

const MIN_FREQ = 20
const MAX_FREQ = 20000
const TILT_DB_PER_OCTAVE = 2.0
const TILT_REFERENCE_HZ = 1000

function frequencyAtX(x: number, width: number, minFrequency: number, maxFrequency: number): number {
  const t = width <= 0 ? 0 : x / width
  const safeMin = Math.max(1, minFrequency)
  const safeMax = Math.max(safeMin + 1, maxFrequency)
  const logMin = Math.log10(safeMin)
  const logMax = Math.log10(safeMax)
  return Math.pow(10, logMin + t * (logMax - logMin))
}

function tiltOffsetAtFrequency(frequency: number): number {
  const safeFreq = Math.max(1, frequency)
  return TILT_DB_PER_OCTAVE * Math.log2(safeFreq / TILT_REFERENCE_HZ)
}

function applyTilt(db: number, frequency: number): number {
  return db + tiltOffsetAtFrequency(frequency)
}

export default function FullscreenAmbientSpectrum({
  className = '',
  opacityIntent = 'subtle'
}: FullscreenAmbientSpectrumProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number | null>(null)
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const smoothedDataRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const canvasSizeRef = useRef({ width: 0, height: 0 })

  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1

    const pixelWidth = Math.max(1, Math.floor(width * dpr))
    const pixelHeight = Math.max(1, Math.floor(height * dpr))

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.width = pixelWidth
    canvas.height = pixelHeight

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    canvasSizeRef.current = { width, height }
  }, [])

  useEffect(() => {
    resizeCanvas()

    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [resizeCanvas])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const lineAlpha = opacityIntent === 'soft' ? 0.56 : 0.46
    const fillTopAlpha = opacityIntent === 'soft' ? 0.17 : 0.12
    const fillMidAlpha = opacityIntent === 'soft' ? 0.08 : 0.05

    const draw = () => {
      const { width, height } = canvasSizeRef.current
      if (width <= 0 || height <= 0) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      ctx.clearRect(0, 0, width, height)

      if (!isRunning || audioEngine.playbackState !== 'playing') {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const analyser = audioEngine.getEQAnalyserNode()
      if (!analyser) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const binCount = analyser.frequencyBinCount
      if (!dataRef.current || dataRef.current.length !== binCount) {
        dataRef.current = new Float32Array(
          new ArrayBuffer(binCount * Float32Array.BYTES_PER_ELEMENT)
        )
      }
      const frequencyData = dataRef.current
      analyser.getFloatFrequencyData(frequencyData)

      if (!smoothedDataRef.current || smoothedDataRef.current.length !== binCount) {
        smoothedDataRef.current = new Float32Array(
          new ArrayBuffer(binCount * Float32Array.BYTES_PER_ELEMENT)
        )
      }
      const smoothedFrequencyData = smoothedDataRef.current

      // High temporal smoothing for calmer fullscreen ambient motion.
      for (let i = 0; i < binCount; i++) {
        smoothedFrequencyData[i] = smoothedFrequencyData[i] * 0.88 + frequencyData[i] * 0.12
      }

      const sampleRate = audioEngine.getSampleRate()
      const nyquist = sampleRate / 2
      const binWidth = nyquist / binCount
      const maxDisplayFreq = Math.max(MIN_FREQ + 1, Math.min(MAX_FREQ, nyquist))
      const minTiltOffset = tiltOffsetAtFrequency(MIN_FREQ)
      const maxTiltOffset = tiltOffsetAtFrequency(maxDisplayFreq)

      // Keep the normalization window aligned to analyser limits after tilt is applied.
      const minDb = analyser.minDecibels + Math.min(minTiltOffset, maxTiltOffset)
      const maxDb = analyser.maxDecibels + Math.max(minTiltOffset, maxTiltOffset)

      const points: Array<{ x: number; y: number }> = []
      const numPoints = Math.max(2, Math.floor(width))

      for (let i = 0; i < numPoints; i++) {
        const x = i
        const freq = Math.max(MIN_FREQ, frequencyAtX(x, width, MIN_FREQ, maxDisplayFreq))
        const bin = freq / binWidth
        const low = Math.floor(bin)
        const high = Math.min(low + 1, binCount - 1)
        const frac = bin - low

        const dbLow = smoothedFrequencyData[low] ?? -95
        const dbHigh = smoothedFrequencyData[high] ?? -95
        const db = dbLow + (dbHigh - dbLow) * frac
        const tiltedDb = applyTilt(db, freq)

        const clampedDb = Math.max(minDb, Math.min(maxDb, tiltedDb))
        const normalized = (clampedDb - minDb) / (maxDb - minDb)
        const shaped = Math.pow(Math.max(0, Math.min(1, normalized)), 0.86)
        const y = height - shaped * height
        points.push({ x, y })
      }

      if (points.length < 2) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()

      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, colorWithAlpha(lineColor, 0))
      gradient.addColorStop(0.45, colorWithAlpha(lineColor, fillMidAlpha))
      gradient.addColorStop(1, colorWithAlpha(lineColor, fillTopAlpha))
      ctx.fillStyle = gradient
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(lineColor, lineAlpha)
      ctx.lineWidth = 1.8
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()

      animationRef.current = window.requestAnimationFrame(draw)
    }

    animationRef.current = window.requestAnimationFrame(draw)

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [isRunning, lineColor, opacityIntent])

  return (
    <div
      ref={containerRef}
      className={`fullscreen-ambient-spectrum ${className}`.trim()}
      data-opacity-intent={opacityIntent}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="fullscreen-ambient-canvas" />
    </div>
  )
}
