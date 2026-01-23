import { useEffect, useRef, useState, useCallback } from 'react'
import { Oscilloscope, SpectrumAnalyzer, Vectorscope } from '../../audio/visualizers'
import { audioEngine } from '../../audio/AudioEngine'

type VisualizerType = 'oscilloscope' | 'spectrum' | 'vectorscope'
type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384

interface VisualizerPanelProps {
  className?: string
}

export default function VisualizerPanel({ className = '' }: VisualizerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const visualizerRef = useRef<Oscilloscope | SpectrumAnalyzer | Vectorscope | null>(null)

  const [activeType, setActiveType] = useState<VisualizerType>('oscilloscope')
  const [isRunning, setIsRunning] = useState(true)

  // Settings
  const [lineColor, setLineColor] = useState('#00ffff')
  const [fftSize, setFftSize] = useState<FFTSize>(2048)
  const [pitchLock, setPitchLock] = useState(true)

  // Resize handler - measure the canvas container, not the whole panel
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current
    const container = canvasContainerRef.current
    if (!canvas || !container) return

    // Get container dimensions
    const rect = container.getBoundingClientRect()

    // Set canvas to actual pixel dimensions (no DPR scaling for visualizers)
    canvas.width = Math.floor(rect.width)
    canvas.height = Math.floor(rect.height)
  }, [])

  // Update FFT size on audio engine when changed
  useEffect(() => {
    audioEngine.setFFTSize(fftSize)
  }, [fftSize])

  // Create/update visualizer when type or settings change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Stop and dispose current visualizer
    if (visualizerRef.current) {
      visualizerRef.current.stop()
      visualizerRef.current.dispose()
      visualizerRef.current = null
    }

    // Ensure canvas is sized
    handleResize()

    // Create new visualizer based on type
    switch (activeType) {
      case 'oscilloscope':
        visualizerRef.current = new Oscilloscope(canvas, {
          lineColor,
          lineWidth: 2,
          pitchLock,
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
  }, [activeType, lineColor, pitchLock, isRunning, handleResize])

  // Handle resize with ResizeObserver for more reliable sizing
  useEffect(() => {
    handleResize()

    const container = canvasContainerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver(() => {
      handleResize()
    })
    resizeObserver.observe(container)

    window.addEventListener('resize', handleResize)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    }
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
            Scope
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
            Vector
          </button>
        </div>

        <div className="visualizer-settings">
          {/* FFT Size selector */}
          <select
            className="visualizer-select"
            value={fftSize}
            onChange={(e) => setFftSize(Number(e.target.value) as FFTSize)}
            title="FFT Size (quality)"
          >
            <option value={1024}>1024</option>
            <option value={2048}>2048</option>
            <option value={4096}>4096</option>
            <option value={8192}>8192</option>
            <option value={16384}>16384</option>
          </select>

          {/* Pitch lock toggle (only for oscilloscope) */}
          {activeType === 'oscilloscope' && (
            <button
              className={`visualizer-option-btn ${pitchLock ? 'active' : ''}`}
              onClick={() => setPitchLock(!pitchLock)}
              title="Pitch Lock (stabilize waveform)"
            >
              PL
            </button>
          )}

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
      <div className="visualizer-canvas-container" ref={canvasContainerRef}>
        <canvas ref={canvasRef} className="visualizer-canvas" />
      </div>
    </div>
  )
}
