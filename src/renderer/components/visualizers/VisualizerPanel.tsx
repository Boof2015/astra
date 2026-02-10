import { useEffect, useRef, useCallback } from 'react'
import { Oscilloscope, SpectrumAnalyzer, Vectorscope } from '../../audio/visualizers'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'

interface VisualizerPanelProps {
  className?: string
}

const spectrumDbLabels = [
  { value: '-20dB', top: '10%' },
  { value: '-40dB', top: '35%' },
  { value: '-60dB', top: '60%' },
  { value: '-80dB', top: '85%' },
]

const spectrumFreqLabels = [
  { value: '50', left: '12%' },
  { value: '100', left: '28%' },
  { value: '200', left: '42%' },
  { value: '500', left: '52%' },
  { value: '1k', left: '62%' },
  { value: '2k', left: '72%' },
  { value: '5k', left: '82%' },
  { value: '10k', left: '92%' },
]

export default function VisualizerPanel({ className = '' }: VisualizerPanelProps) {
  // Refs for all three canvases
  const scopeCanvasRef = useRef<HTMLCanvasElement>(null)
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null)
  const vectorCanvasRef = useRef<HTMLCanvasElement>(null)

  const scopeContainerRef = useRef<HTMLDivElement>(null)
  const spectrumContainerRef = useRef<HTMLDivElement>(null)
  const vectorContainerRef = useRef<HTMLDivElement>(null)

  // Visualizer instances
  const scopeRef = useRef<Oscilloscope | null>(null)
  const spectrumRef = useRef<SpectrumAnalyzer | null>(null)
  const vectorRef = useRef<Vectorscope | null>(null)

  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)

  // Resize a single canvas to fit its container
  const resizeCanvas = useCallback((canvas: HTMLCanvasElement, container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
  }, [])

  // Resize all canvases
  const handleResize = useCallback(() => {
    if (scopeCanvasRef.current && scopeContainerRef.current) {
      resizeCanvas(scopeCanvasRef.current, scopeContainerRef.current)
    }
    if (spectrumCanvasRef.current && spectrumContainerRef.current) {
      resizeCanvas(spectrumCanvasRef.current, spectrumContainerRef.current)
    }
    if (vectorCanvasRef.current && vectorContainerRef.current) {
      resizeCanvas(vectorCanvasRef.current, vectorContainerRef.current)
    }
  }, [resizeCanvas])

  // FFT size is now managed by individual visualizers (e.g., spectrum analyzer)

  // Create visualizers
  useEffect(() => {
    // Ensure canvases are sized first
    handleResize()

    // Create oscilloscope
    if (scopeCanvasRef.current && !scopeRef.current) {
      scopeRef.current = new Oscilloscope(scopeCanvasRef.current, {
        lineColor,
        lineWidth: 2,
        pitchLock,
        showGrid: true
      })
    }

    // Create spectrum analyzer
    if (spectrumCanvasRef.current && !spectrumRef.current) {
      spectrumRef.current = new SpectrumAnalyzer(spectrumCanvasRef.current, {
        lineColor,
        lineWidth: 2,
        fillGradient: true,
        fftSize,
        gradientColors: [
          'rgba(0, 255, 255, 0)',
          `${lineColor}33`,
          `${lineColor}66`
        ],
        scaleType: 'log',
        showGrid: true
      })
    }

    // Create vectorscope
    if (vectorCanvasRef.current && !vectorRef.current) {
      vectorRef.current = new Vectorscope(vectorCanvasRef.current, {
        lineColor,
        lineWidth: 1,
        showGrid: true
      })
    }

    // Start all if running
    if (isRunning) {
      scopeRef.current?.start()
      spectrumRef.current?.start()
      vectorRef.current?.start()
    }

    return () => {
      scopeRef.current?.dispose()
      spectrumRef.current?.dispose()
      vectorRef.current?.dispose()
      scopeRef.current = null
      spectrumRef.current = null
      vectorRef.current = null
    }
  }, []) // Only run once on mount

  // Update visualizer options when settings change
  useEffect(() => {
    scopeRef.current?.setOptions({ lineColor, pitchLock })
    spectrumRef.current?.setOptions({
      lineColor,
      fftSize,
      gradientColors: [
        'rgba(0, 255, 255, 0)',
        `${lineColor}33`,
        `${lineColor}66`
      ]
    })
    vectorRef.current?.setOptions({ lineColor })
  }, [lineColor, pitchLock, fftSize])

  // Handle running state changes
  useEffect(() => {
    if (isRunning) {
      scopeRef.current?.start()
      spectrumRef.current?.start()
      vectorRef.current?.start()
    } else {
      scopeRef.current?.stop()
      spectrumRef.current?.stop()
      vectorRef.current?.stop()
    }
  }, [isRunning])

  // Handle resize with ResizeObserver
  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })

    if (scopeContainerRef.current) observer.observe(scopeContainerRef.current)
    if (spectrumContainerRef.current) observer.observe(spectrumContainerRef.current)
    if (vectorContainerRef.current) observer.observe(vectorContainerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div className={`visualizer-panel ${className}`}>
      <div className="visualizer-grid">
        <div className="visualizer-item visualizer-item-spectrum" ref={spectrumContainerRef}>
          <div className="visualizer-caption-left">SPECTRUM</div>
          <div className="visualizer-caption-right">FFT {fftSize}</div>
          <canvas ref={spectrumCanvasRef} className="visualizer-canvas" />
          {spectrumDbLabels.map((label) => (
            <span
              key={label.value}
              className="visualizer-db-label"
              style={{ top: label.top }}
            >
              {label.value}
            </span>
          ))}
          {spectrumFreqLabels.map((label) => (
            <span
              key={label.value}
              className="visualizer-freq-label"
              style={{ left: label.left }}
            >
              {label.value}
            </span>
          ))}
        </div>

        <div className="visualizer-item visualizer-item-scope" ref={scopeContainerRef}>
          <div className="visualizer-caption-left">OSCILLOSCOPE</div>
          <div className="visualizer-caption-right">{pitchLock ? 'PITCH-LOCK' : 'FREE-RUN'}</div>
          <canvas ref={scopeCanvasRef} className="visualizer-canvas" />
        </div>

        <div className="visualizer-item visualizer-item-vector" ref={vectorContainerRef}>
          <div className="visualizer-caption-left">VECTORSCOPE</div>
          <div className="visualizer-caption-right">{isRunning ? 'LIVE' : 'PAUSED'}</div>
          <canvas ref={vectorCanvasRef} className="visualizer-canvas" />
        </div>
      </div>
    </div>
  )
}
