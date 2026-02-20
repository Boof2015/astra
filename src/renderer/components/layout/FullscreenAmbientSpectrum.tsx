import { useEffect, useRef, useCallback } from 'react'
import { audioEngine } from '../../audio/AudioEngine'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import {
  AMBIENT_SPECTRUM_MAX_FREQ,
  AMBIENT_SPECTRUM_MIN_FREQ,
  applyTilt,
  colorWithAlpha,
  frequencyAtX,
  tiltOffsetAtFrequency
} from '../visualizers/ambientSpectrumMath'

export interface FullscreenAmbientSpectrumProps {
  className?: string
  opacityIntent?: 'subtle' | 'soft'
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
    const runtimeAccent = window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      || lineColor

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
        smoothedFrequencyData[i] = smoothedFrequencyData[i] * 0.92 + frequencyData[i] * 0.08
      }

      const sampleRate = audioEngine.getSampleRate()
      const nyquist = sampleRate / 2
      const binWidth = nyquist / binCount
      const maxDisplayFreq = Math.max(AMBIENT_SPECTRUM_MIN_FREQ + 1, Math.min(AMBIENT_SPECTRUM_MAX_FREQ, nyquist))
      const minTiltOffset = tiltOffsetAtFrequency(AMBIENT_SPECTRUM_MIN_FREQ)
      const maxTiltOffset = tiltOffsetAtFrequency(maxDisplayFreq)

      // Keep the normalization window aligned to analyser limits after tilt is applied.
      const minDb = analyser.minDecibels + Math.min(minTiltOffset, maxTiltOffset)
      const maxDb = analyser.maxDecibels + Math.max(minTiltOffset, maxTiltOffset)

      const points: Array<{ x: number; y: number }> = []
      const numPoints = Math.max(2, Math.floor(width))

      for (let i = 0; i < numPoints; i++) {
        const x = i
        const freq = Math.max(
          AMBIENT_SPECTRUM_MIN_FREQ,
          frequencyAtX(x, width, AMBIENT_SPECTRUM_MIN_FREQ, maxDisplayFreq)
        )
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
      gradient.addColorStop(0, colorWithAlpha(lineColor, 0, runtimeAccent))
      gradient.addColorStop(0.45, colorWithAlpha(lineColor, fillMidAlpha, runtimeAccent))
      gradient.addColorStop(1, colorWithAlpha(lineColor, fillTopAlpha, runtimeAccent))
      ctx.fillStyle = gradient
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(lineColor, lineAlpha, runtimeAccent)
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
