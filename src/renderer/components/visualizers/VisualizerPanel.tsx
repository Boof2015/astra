import { useEffect, useRef, useState, useCallback } from 'react'
import { Oscilloscope, SpectrumAnalyzer, Vectorscope } from '../../audio/visualizers'

type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384

interface VisualizerPanelProps {
  className?: string
}

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

  const [isRunning, setIsRunning] = useState(true)

  // Settings
  const [lineColor, setLineColor] = useState('#00ffff')
  const [fftSize, setFftSize] = useState<FFTSize>(2048)
  const [pitchLock, setPitchLock] = useState(true)

  // Resize a single canvas to fit its container
  const resizeCanvas = useCallback((canvas: HTMLCanvasElement, container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect()
    canvas.width = Math.floor(rect.width)
    canvas.height = Math.floor(rect.height)
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

  const toggleRunning = () => setIsRunning(prev => !prev)

  return (
    <div className={`visualizer-panel ${className}`}>
      <div className="visualizer-controls">
        <div className="visualizer-labels">
          <span className="visualizer-label">Scope</span>
          <span className="visualizer-label">Spectrum</span>
          <span className="visualizer-label">Vector</span>
        </div>

        <div className="visualizer-settings">
          <select
            className="visualizer-select"
            value={fftSize}
            onChange={(e) => setFftSize(Number(e.target.value) as FFTSize)}
            title="FFT Size"
          >
            <option value={1024}>1024</option>
            <option value={2048}>2048</option>
            <option value={4096}>4096</option>
            <option value={8192}>8192</option>
            <option value={16384}>16384</option>
          </select>

          <button
            className={`visualizer-option-btn ${pitchLock ? 'active' : ''}`}
            onClick={() => setPitchLock(!pitchLock)}
            title="Pitch Lock"
          >
            PL
          </button>

          <label className="color-picker-label">
            <input
              type="color"
              value={lineColor}
              onChange={(e) => setLineColor(e.target.value)}
              className="color-picker"
            />
          </label>

          <button
            className={`visualizer-toggle-btn ${isRunning ? 'running' : ''}`}
            onClick={toggleRunning}
            title={isRunning ? 'Pause' : 'Play'}
          >
            {isRunning ? '⏸' : '▶'}
          </button>
        </div>
      </div>

      <div className="visualizer-grid">
        <div className="visualizer-item" ref={scopeContainerRef}>
          <canvas ref={scopeCanvasRef} className="visualizer-canvas" />
        </div>
        <div className="visualizer-item" ref={spectrumContainerRef}>
          <canvas ref={spectrumCanvasRef} className="visualizer-canvas" />
        </div>
        <div className="visualizer-item visualizer-item-square" ref={vectorContainerRef}>
          <canvas ref={vectorCanvasRef} className="visualizer-canvas" />
        </div>
      </div>
    </div>
  )
}
