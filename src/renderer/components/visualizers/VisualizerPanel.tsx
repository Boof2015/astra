import { useEffect, useRef, useState, useCallback } from 'react'
import { Oscilloscope, SpectrumAnalyzer, Vectorscope } from '../../audio/visualizers'

type VisualizerType = 'oscilloscope' | 'spectrum' | 'vectorscope'

interface VisualizerPanelProps {
  className?: string
}

export default function VisualizerPanel({ className = '' }: VisualizerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const visualizerRef = useRef<Oscilloscope | SpectrumAnalyzer | Vectorscope | null>(null)

  const [activeType, setActiveType] = useState<VisualizerType>('oscilloscope')
  const [isRunning, setIsRunning] = useState(true)

  // Color settings
  const [lineColor, setLineColor] = useState('#00ffff')

  // Resize handler
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // Get container dimensions
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    // Set canvas size accounting for device pixel ratio
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    // Scale canvas CSS size
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`

    // Scale context for DPR
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.scale(dpr, dpr)
      // Reset scale for visualizer (it will use canvas.width/height)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }, [])

  // Create/update visualizer when type changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Stop and dispose current visualizer
    if (visualizerRef.current) {
      visualizerRef.current.stop()
      visualizerRef.current.dispose()
      visualizerRef.current = null
    }

    // Create new visualizer based on type
    switch (activeType) {
      case 'oscilloscope':
        visualizerRef.current = new Oscilloscope(canvas, {
          lineColor,
          lineWidth: 2,
          pitchLock: true,
          showGrid: true
        })
        break
      case 'spectrum':
        visualizerRef.current = new SpectrumAnalyzer(canvas, {
          lineColor,
          lineWidth: 2,
          fillGradient: true,
          gradientColors: [
            'rgba(0, 255, 255, 0)',
            `${lineColor}33`,
            `${lineColor}66`
          ],
          scaleType: 'log',
          showGrid: true
        })
        break
      case 'vectorscope':
        visualizerRef.current = new Vectorscope(canvas, {
          lineColor,
          lineWidth: 1.5,
          fadeAmount: 0.12,
          colorByIntensity: true,
          intensityColors: ['#00ffff', '#ff00ff', '#ff0066'],
          showGrid: true
        })
        break
    }

    // Start if should be running
    if (isRunning && visualizerRef.current) {
      visualizerRef.current.start()
    }

    return () => {
      if (visualizerRef.current) {
        visualizerRef.current.stop()
        visualizerRef.current.dispose()
      }
    }
  }, [activeType, lineColor, isRunning])

  // Handle resize
  useEffect(() => {
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  // Toggle running state
  const toggleRunning = () => {
    setIsRunning(prev => {
      const next = !prev
      if (visualizerRef.current) {
        if (next) {
          visualizerRef.current.start()
        } else {
          visualizerRef.current.stop()
        }
      }
      return next
    })
  }

  return (
    <div className={`visualizer-panel ${className}`} ref={containerRef}>
      <div className="visualizer-controls">
        <div className="visualizer-type-selector">
          <button
            className={`visualizer-type-btn ${activeType === 'oscilloscope' ? 'active' : ''}`}
            onClick={() => setActiveType('oscilloscope')}
          >
            Oscilloscope
          </button>
          <button
            className={`visualizer-type-btn ${activeType === 'spectrum' ? 'active' : ''}`}
            onClick={() => setActiveType('spectrum')}
          >
            Spectrum
          </button>
          <button
            className={`visualizer-type-btn ${activeType === 'vectorscope' ? 'active' : ''}`}
            onClick={() => setActiveType('vectorscope')}
          >
            Vectorscope
          </button>
        </div>
        <div className="visualizer-settings">
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
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}
