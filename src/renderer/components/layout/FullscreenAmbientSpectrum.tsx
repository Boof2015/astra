import { useEffect, useRef, useCallback } from 'react'
import { SpectrumAnalyzer } from '../../audio/visualizers'
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

export default function FullscreenAmbientSpectrum({
  className = '',
  opacityIntent = 'subtle'
}: FullscreenAmbientSpectrumProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const spectrumRef = useRef<SpectrumAnalyzer | null>(null)

  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
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

    const analyzer = new SpectrumAnalyzer(canvas, {
      lineColor: colorWithAlpha(lineColor, 0.4),
      lineWidth: 1.2,
      fillGradient: true,
      gradientColors: [
        colorWithAlpha(lineColor, 0),
        colorWithAlpha(lineColor, 0.06),
        colorWithAlpha(lineColor, 0.18)
      ],
      backgroundColor: 'transparent',
      showGrid: false,
      scaleType: 'log',
      smoothing: 0.92,
      minDecibels: -95,
      maxDecibels: -18,
      tiltDbPerOctave: 1.8,
      tiltReferenceHz: 900,
      fftSize
    })

    spectrumRef.current = analyzer
    if (isRunning) analyzer.start()

    return () => {
      analyzer.dispose()
      spectrumRef.current = null
    }
  }, [])

  useEffect(() => {
    spectrumRef.current?.setOptions({
      lineColor: colorWithAlpha(lineColor, 0.4),
      gradientColors: [
        colorWithAlpha(lineColor, 0),
        colorWithAlpha(lineColor, 0.06),
        colorWithAlpha(lineColor, 0.18)
      ],
      fftSize
    })
  }, [lineColor, fftSize])

  useEffect(() => {
    const spectrum = spectrumRef.current
    if (!spectrum) return

    if (isRunning) {
      spectrum.start()
    } else {
      spectrum.stop()
    }
  }, [isRunning])

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
