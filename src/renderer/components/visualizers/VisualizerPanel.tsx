import { useCallback, useEffect, useRef } from 'react'
import { Oscilloscope, SpectrumAnalyzer, Vectorscope } from '../../audio/visualizers'
import { useScopePopoutStore } from '../../stores/scopePopoutStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import type { ScopeKind } from '../../../types/scopePopout'

interface VisualizerPanelProps {
  className?: string
}

function resizeCanvasToContainer(canvas: HTMLCanvasElement, container: HTMLDivElement): void {
  const rect = container.getBoundingClientRect()
  const width = Math.max(1, Math.floor(rect.width))
  const height = Math.max(1, Math.floor(rect.height))
  const dpr = window.devicePixelRatio || 1

  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.width = Math.max(1, Math.floor(width * dpr))
  canvas.height = Math.max(1, Math.floor(height * dpr))
}

function DockedSpectrumTile({
  lineColor,
  fftSize,
  isRunning
}: {
  lineColor: string
  fftSize: number
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<SpectrumAnalyzer | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new SpectrumAnalyzer(canvasRef.current, {
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

    if (isRunning) {
      visualizerRef.current?.start()
    }

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [handleResize])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      fftSize,
      gradientColors: [
        'rgba(0, 255, 255, 0)',
        `${lineColor}33`,
        `${lineColor}66`
      ]
    })
  }, [lineColor, fftSize])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedOscilloscopeTile({
  lineColor,
  pitchLock,
  isRunning
}: {
  lineColor: string
  pitchLock: boolean
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Oscilloscope | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Oscilloscope(canvasRef.current, {
        lineColor,
        lineWidth: 2,
        pitchLock,
        showGrid: true
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [handleResize])

  useEffect(() => {
    visualizerRef.current?.setOptions({ lineColor, pitchLock })
  }, [lineColor, pitchLock])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedVectorscopeTile({
  lineColor,
  isRunning
}: {
  lineColor: string
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Vectorscope | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Vectorscope(canvasRef.current, {
        lineColor,
        lineWidth: 1,
        showGrid: true
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [handleResize])

  useEffect(() => {
    visualizerRef.current?.setOptions({ lineColor })
  }, [lineColor])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function scopeLabel(scope: ScopeKind): string {
  switch (scope) {
    case 'spectrum':
      return 'Spectrum'
    case 'oscilloscope':
      return 'Oscilloscope'
    case 'vectorscope':
      return 'Vectorscope'
  }
}

function PopoutPlaceholder({
  scope,
  onRecall
}: {
  scope: ScopeKind
  onRecall: () => void
}) {
  return (
    <div className="visualizer-popout-placeholder">
      <div className="visualizer-popout-placeholder-label">{scopeLabel(scope)} detached</div>
      <button
        className="visualizer-popout-placeholder-btn"
        onClick={onRecall}
        aria-label={`Recall ${scopeLabel(scope)}`}
      >
        Recall
      </button>
    </div>
  )
}

export default function VisualizerPanel({ className = '' }: VisualizerPanelProps) {
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)
  const scopePopoutState = useScopePopoutStore((s) => s.state)

  const openScopePopout = useCallback((scope: ScopeKind) => {
    void window.electronAPI.scopePopout.open(scope)
  }, [])

  const recallScopePopout = useCallback((scope: ScopeKind) => {
    void window.electronAPI.scopePopout.recall(scope)
  }, [])

  return (
    <div className={`visualizer-panel ${className}`}>
      <div className="visualizer-grid">
        <div className={`visualizer-item visualizer-item-spectrum ${scopePopoutState.spectrum ? 'is-popped-out' : ''}`}>
          <div className="visualizer-caption-left">SPECTRUM</div>
          <div className="visualizer-caption-right-group">
            <div className="visualizer-caption-right">{scopePopoutState.spectrum ? 'POPPED OUT' : `FFT ${fftSize}`}</div>
            {!scopePopoutState.spectrum && (
              <button
                className="visualizer-popout-btn"
                onClick={() => openScopePopout('spectrum')}
                title="Pop out spectrum"
                aria-label="Pop out spectrum"
              >
                Pop
              </button>
            )}
          </div>
          {scopePopoutState.spectrum ? (
            <PopoutPlaceholder scope="spectrum" onRecall={() => recallScopePopout('spectrum')} />
          ) : (
            <DockedSpectrumTile
              lineColor={lineColor}
              fftSize={fftSize}
              isRunning={isRunning}
            />
          )}
        </div>

        <div className={`visualizer-item visualizer-item-scope ${scopePopoutState.oscilloscope ? 'is-popped-out' : ''}`}>
          <div className="visualizer-caption-left">OSCILLOSCOPE</div>
          <div className="visualizer-caption-right-group">
            <div className="visualizer-caption-right">{scopePopoutState.oscilloscope ? 'POPPED OUT' : pitchLock ? 'PITCH-LOCK' : 'FREE-RUN'}</div>
            {!scopePopoutState.oscilloscope && (
              <button
                className="visualizer-popout-btn"
                onClick={() => openScopePopout('oscilloscope')}
                title="Pop out oscilloscope"
                aria-label="Pop out oscilloscope"
              >
                Pop
              </button>
            )}
          </div>
          {scopePopoutState.oscilloscope ? (
            <PopoutPlaceholder scope="oscilloscope" onRecall={() => recallScopePopout('oscilloscope')} />
          ) : (
            <DockedOscilloscopeTile
              lineColor={lineColor}
              pitchLock={pitchLock}
              isRunning={isRunning}
            />
          )}
        </div>

        <div className={`visualizer-item visualizer-item-vector ${scopePopoutState.vectorscope ? 'is-popped-out' : ''}`}>
          <div className="visualizer-caption-left">VECTORSCOPE</div>
          <div className="visualizer-caption-right-group">
            <div className="visualizer-caption-right">{scopePopoutState.vectorscope ? 'POPPED OUT' : isRunning ? 'LIVE' : 'PAUSED'}</div>
            {!scopePopoutState.vectorscope && (
              <button
                className="visualizer-popout-btn"
                onClick={() => openScopePopout('vectorscope')}
                title="Pop out vectorscope"
                aria-label="Pop out vectorscope"
              >
                Pop
              </button>
            )}
          </div>
          {scopePopoutState.vectorscope ? (
            <PopoutPlaceholder scope="vectorscope" onRecall={() => recallScopePopout('vectorscope')} />
          ) : (
            <DockedVectorscopeTile
              lineColor={lineColor}
              isRunning={isRunning}
            />
          )}
        </div>
      </div>
    </div>
  )
}
