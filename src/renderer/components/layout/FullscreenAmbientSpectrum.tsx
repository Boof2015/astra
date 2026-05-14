import { useEffect, useRef, useCallback } from 'react'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import {
  getEQAnalyzerFrameSnapshot,
  subscribeToEQAnalyzerFrames,
} from '../../audio/eqAnalyzerFrameSource'
import {
  AMBIENT_SPECTRUM_MAX_FREQ,
  AMBIENT_SPECTRUM_MIN_FREQ,
  applyTilt,
  colorWithAlpha,
  frequencyAtX,
  tiltOffsetAtFrequency
} from '../visualizers/ambientSpectrumMath'
import {
  resolveFullscreenAmbientCanvasSize,
  type FullscreenAmbientCanvasSize
} from '../../utils/fullscreenAmbientCanvas'

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
  const smoothedDataRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const canvasSizeRef = useRef<FullscreenAmbientCanvasSize | null>(null)

  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const nextSize = resolveFullscreenAmbientCanvasSize(
      rect.width,
      rect.height,
      window.devicePixelRatio || 1
    )

    canvas.style.width = `${nextSize.cssWidth}px`
    canvas.style.height = `${nextSize.cssHeight}px`
    if (canvas.width !== nextSize.pixelWidth || canvas.height !== nextSize.pixelHeight) {
      canvas.width = nextSize.pixelWidth
      canvas.height = nextSize.pixelHeight
    }

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(nextSize.dpr, 0, 0, nextSize.dpr, 0, 0)
    }
    canvasSizeRef.current = nextSize
  }, [])

  useEffect(() => {
    resizeCanvas()

    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      smoothedDataRef.current = null
      canvasSizeRef.current = null
    }
  }, [resizeCanvas])

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const runtimeAccent = window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      || lineColor

    const lineAlpha = opacityIntent === 'soft' ? 0.56 : 0.46
    const fillTopAlpha = opacityIntent === 'soft' ? 0.17 : 0.12
    const fillMidAlpha = opacityIntent === 'soft' ? 0.08 : 0.05

    const { cssWidth: width, cssHeight: height } = canvasSizeRef.current ?? { cssWidth: 0, cssHeight: 0 }
    if (width <= 0 || height <= 0) {
      return
    }

    ctx.clearRect(0, 0, width, height)

    const snapshot = getEQAnalyzerFrameSnapshot()
    const frequencyData = snapshot.data
    if (!isRunning || !snapshot.available || !frequencyData || frequencyData.length === 0) {
      return
    }

    const binCount = frequencyData.length
    if (!smoothedDataRef.current || smoothedDataRef.current.length !== binCount) {
      smoothedDataRef.current = new Float32Array(
        new ArrayBuffer(binCount * Float32Array.BYTES_PER_ELEMENT)
      )
    }
    const smoothedFrequencyData = smoothedDataRef.current

    for (let i = 0; i < binCount; i++) {
      smoothedFrequencyData[i] = smoothedFrequencyData[i] * 0.92 + frequencyData[i] * 0.08
    }

    const nyquist = snapshot.sampleRate / 2
    const binWidth = nyquist / binCount
    const maxDisplayFreq = Math.max(AMBIENT_SPECTRUM_MIN_FREQ + 1, Math.min(AMBIENT_SPECTRUM_MAX_FREQ, nyquist))
    const minTiltOffset = tiltOffsetAtFrequency(AMBIENT_SPECTRUM_MIN_FREQ)
    const maxTiltOffset = tiltOffsetAtFrequency(maxDisplayFreq)
    const minDb = snapshot.minDecibels + Math.min(minTiltOffset, maxTiltOffset)
    const maxDb = snapshot.maxDecibels + Math.max(minTiltOffset, maxTiltOffset)

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
  }, [isRunning, lineColor, opacityIntent])

  useEffect(() => {
    renderFrame()
    const unsubscribe = subscribeToEQAnalyzerFrames(() => {
      renderFrame()
    })
    return () => {
      unsubscribe()
    }
  }, [renderFrame])

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
