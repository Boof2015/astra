import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { audioEngine } from '../../audio/AudioEngine'
import { LUFSMeter, Oscilloscope, SpectrumAnalyzer, Spectrogram, Vectorscope, VUMeter, Waveform } from '../../audio/visualizers'
import { buildAnalyzerGridTemplateColumns } from '../layout/analyzerLayout'
import { useScopePopoutStore } from '../../stores/scopePopoutStore'
import { useVisualizerSettingsStore, type VectorscopeMode } from '../../stores/visualizerSettingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { ScopeKind } from '../../../types/scopePopout'
import type { SpectrogramClarityMode, SpectrogramScaleMode } from '../../../types/spectrogram'
import type { VUMeterMode } from '../../../types/vumeter'

interface VisualizerPanelProps {
  className?: string
  visibleScopes?: ScopeKind[]
  gridTemplateColumns?: string
  isEditMode?: boolean
  draggedScope?: ScopeKind | null
  highlightedScope?: ScopeKind | null
  rackDropIndex?: number | null
  onRackScopeDragStart?: (scope: ScopeKind, fromHidden: boolean, event: DragEvent<HTMLDivElement>) => void
  onRackScopeDragOver?: (index: number, event: DragEvent<HTMLDivElement>) => void
  onRackScopeDrop?: (event: DragEvent<HTMLDivElement>) => void
  onRackScopeDragEnd?: () => void
  onRackEmptyDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onRackEmptyDrop?: (event: DragEvent<HTMLDivElement>) => void
  onScopeHoverChange?: (scope: ScopeKind | null) => void
  onScopeActivate?: (scope: ScopeKind) => void
  onResizePreviewChange?: (weights: Partial<Record<ScopeKind, number>> | null) => void
}

interface ResizeSession {
  leftScope: ScopeKind
  rightScope: ScopeKind
  startClientX: number
  startLeftWidth: number
  pairWidth: number
  pairWeight: number
}

const MIN_SCOPE_WIDTH_PX = 112
const MIN_VECTORSCOPE_WIDTH_PX = 96
const MIN_PREVIEW_WEIGHT = 0.4
const MAX_PREVIEW_WEIGHT = 2.6

function scopeMinWidthPx(scope: ScopeKind): number {
  return scope === 'vectorscope' ? MIN_VECTORSCOPE_WIDTH_PX : MIN_SCOPE_WIDTH_PX
}

function clampPreviewWeight(value: number): number {
  if (!Number.isFinite(value)) return 1
  const normalized = Math.round(value * 100) / 100
  return Math.min(MAX_PREVIEW_WEIGHT, Math.max(MIN_PREVIEW_WEIGHT, normalized))
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
    visualizerRef.current?.resize()
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
  underfillEnabled,
  isRunning
}: {
  lineColor: string
  pitchLock: boolean
  underfillEnabled: boolean
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Oscilloscope | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Oscilloscope(canvasRef.current, {
        lineColor,
        lineWidth: 2,
        pitchLock,
        underfillEnabled,
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
    visualizerRef.current?.setOptions({ lineColor, pitchLock, underfillEnabled })
  }, [lineColor, pitchLock, underfillEnabled])

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
  vectorscopeMode,
  vectorscopeMultiband,
  isRunning
}: {
  lineColor: string
  vectorscopeMode: VectorscopeMode
  vectorscopeMultiband: boolean
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Vectorscope | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Vectorscope(canvasRef.current, {
        lineColor,
        lineWidth: 1,
        showGrid: true,
        mode: vectorscopeMode,
        multiband: vectorscopeMultiband,
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
    visualizerRef.current?.setOptions({ lineColor, mode: vectorscopeMode, multiband: vectorscopeMultiband })
  }, [lineColor, vectorscopeMode, vectorscopeMultiband])

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

function DockedSpectrogramTile({
  lineColor,
  fftSize,
  scrollSpeed,
  clarityMode,
  scaleMode,
  isRunning
}: {
  lineColor: string
  fftSize: number
  scrollSpeed: number
  clarityMode: SpectrogramClarityMode
  scaleMode: SpectrogramScaleMode
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Spectrogram | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Spectrogram(canvasRef.current, {
        lineColor,
        fftSize,
        scrollSpeed,
        clarityMode,
        scaleMode,
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
    visualizerRef.current?.setOptions({ lineColor, fftSize, scrollSpeed, clarityMode, scaleMode })
  }, [clarityMode, lineColor, fftSize, scrollSpeed, scaleMode])

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

function DockedVUMeterTile({
  lineColor,
  vuMeterMode,
  isRunning,
}: {
  lineColor: string
  vuMeterMode: VUMeterMode
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<VUMeter | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new VUMeter(canvasRef.current, {
        lineColor,
        mode: vuMeterMode,
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
    visualizerRef.current?.setOptions({ lineColor, mode: vuMeterMode })
  }, [lineColor, vuMeterMode])

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

function DockedLUFSMeterTile({
  lineColor,
  isRunning,
}: {
  lineColor: string
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<LUFSMeter | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new LUFSMeter(canvasRef.current, {
        lineColor,
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

function DockedWaveformTile({
  lineColor,
  scrollSpeed,
  multiband,
  isRunning,
}: {
  lineColor: string
  scrollSpeed: number
  multiband: boolean
  isRunning: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Waveform | null>(null)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Waveform(canvasRef.current, {
        lineColor,
        scrollSpeed,
        multiband,
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
    visualizerRef.current?.setOptions({ lineColor, scrollSpeed, multiband })
  }, [lineColor, scrollSpeed, multiband])

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

function vectorscopeModeLabelShort(mode: VectorscopeMode): string {
  switch (mode) {
    case 'lissajous': return 'LISSAJOUS'
    case 'polar-unipolar': return 'POLAR UNI'
    case 'polar-bipolar': return 'POLAR BI'
    case 'linear-unipolar': return 'LINEAR UNI'
    case 'linear-bipolar': return 'LINEAR BI'
  }
}

function spectrogramClarityLabelShort(mode: SpectrogramClarityMode): string {
  switch (mode) {
    case 'classic': return 'CLASSIC'
    case 'sharp': return 'SHARP'
    case 'sharper': return 'SHARPER'
  }
}

function spectrogramScaleLabelShort(mode: SpectrogramScaleMode): string {
  switch (mode) {
    case 'mel': return 'MEL'
    case 'log': return 'LOG'
    case 'linear': return 'LIN'
  }
}

function scopeLabel(scope: ScopeKind): string {
  switch (scope) {
    case 'spectrum':
      return 'Spectrum'
    case 'oscilloscope':
      return 'Oscilloscope'
    case 'vectorscope':
      return 'Vectorscope'
    case 'spectrogram':
      return 'Spectrogram'
    case 'vumeter':
      return 'VU Meter'
    case 'lufsmeter':
      return 'LUFS Meter'
    case 'waveform':
      return 'Waveform'
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

export default function VisualizerPanel({
  className = '',
  visibleScopes: visibleScopesProp,
  gridTemplateColumns: gridTemplateColumnsProp,
  isEditMode = false,
  draggedScope = null,
  highlightedScope = null,
  rackDropIndex = null,
  onRackScopeDragStart,
  onRackScopeDragOver,
  onRackScopeDrop,
  onRackScopeDragEnd,
  onRackEmptyDragOver,
  onRackEmptyDrop,
  onScopeHoverChange,
  onScopeActivate,
  onResizePreviewChange,
}: VisualizerPanelProps) {
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const spectrogramFftSize = useVisualizerSettingsStore((s) => s.spectrogramFftSize)
  const spectrogramScrollSpeed = useVisualizerSettingsStore((s) => s.spectrogramScrollSpeed)
  const spectrogramClarityMode = useVisualizerSettingsStore((s) => s.spectrogramClarityMode)
  const spectrogramScaleMode = useVisualizerSettingsStore((s) => s.spectrogramScaleMode)
  const waveformScrollSpeed = useVisualizerSettingsStore((s) => s.waveformScrollSpeed)
  const waveformMultiband = useVisualizerSettingsStore((s) => s.waveformMultiband)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)
  const vectorscopeMode = useVisualizerSettingsStore((s) => s.vectorscopeMode)
  const vectorscopeMultiband = useVisualizerSettingsStore((s) => s.vectorscopeMultiband)
  const vuMeterMode = useVisualizerSettingsStore((s) => s.vuMeterMode)
  const scopeOrder = useVisualizerSettingsStore((s) => s.scopeOrder)
  const hiddenScopes = useVisualizerSettingsStore((s) => s.hiddenScopes)
  const widthWeights = useVisualizerSettingsStore((s) => s.widthWeights)
  const setScopeWidthWeights = useVisualizerSettingsStore((s) => s.setScopeWidthWeights)
  const scopePopoutState = useScopePopoutStore((s) => s.state)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setPendingSettingsSection = useUIStore((s) => s.setPendingSettingsSection)
  const gridRef = useRef<HTMLDivElement>(null)
  const scopeElementRefs = useRef<Partial<Record<ScopeKind, HTMLDivElement | null>>>({})
  const resizeSessionRef = useRef<ResizeSession | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const resizePreviewWeightsRef = useRef<Partial<Record<ScopeKind, number>> | null>(null)
  const [resizePreviewWeights, setResizePreviewWeights] = useState<Partial<Record<ScopeKind, number>> | null>(null)
  const [handleOffsets, setHandleOffsets] = useState<number[]>([])

  const openScopePopout = useCallback((scope: ScopeKind) => {
    void window.electronAPI.scopePopout.open(scope)
  }, [])

  const recallScopePopout = useCallback((scope: ScopeKind) => {
    void window.electronAPI.scopePopout.recall(scope)
  }, [])

  const visibleScopesFromStore = useMemo(() => {
    return scopeOrder.filter((scope) => !hiddenScopes.includes(scope))
  }, [hiddenScopes, scopeOrder])
  const visibleScopes = visibleScopesProp ?? visibleScopesFromStore

  const effectiveWidthWeights = useMemo(() => {
    if (!resizePreviewWeights) return widthWeights
    return {
      ...widthWeights,
      ...resizePreviewWeights,
    }
  }, [resizePreviewWeights, widthWeights])

  const derivedGridTemplateColumns = useMemo(() => {
    return buildAnalyzerGridTemplateColumns(visibleScopes, effectiveWidthWeights)
  }, [effectiveWidthWeights, visibleScopes])
  const gridTemplateColumns = gridTemplateColumnsProp ?? derivedGridTemplateColumns

  useEffect(() => {
    resizePreviewWeightsRef.current = resizePreviewWeights
  }, [resizePreviewWeights])

  const stopResize = useCallback((commit: boolean) => {
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = null

    const previewWeights = resizePreviewWeightsRef.current
    resizeSessionRef.current = null
    resizePreviewWeightsRef.current = null
    setResizePreviewWeights(null)
    onResizePreviewChange?.(null)

    if (commit && previewWeights) {
      setScopeWidthWeights(previewWeights)
    }
  }, [onResizePreviewChange, setScopeWidthWeights])

  useEffect(() => {
    if (isEditMode) return
    stopResize(false)
  }, [isEditMode, stopResize])

  useEffect(() => {
    stopResize(false)
  }, [visibleScopes.length, stopResize])

  const updateHandleOffsets = useCallback(() => {
    if (!isEditMode || visibleScopes.length < 2) {
      setHandleOffsets([])
      return
    }

    const nextOffsets: number[] = []
    for (let index = 0; index < visibleScopes.length - 1; index += 1) {
      const leftElement = scopeElementRefs.current[visibleScopes[index]]
      if (!leftElement) continue
      nextOffsets.push(leftElement.offsetLeft + leftElement.offsetWidth)
    }
    setHandleOffsets(nextOffsets)
  }, [isEditMode, visibleScopes])

  useEffect(() => {
    updateHandleOffsets()

    if (!isEditMode) {
      return
    }

    const observer = new ResizeObserver(() => {
      updateHandleOffsets()
    })

    if (gridRef.current) {
      observer.observe(gridRef.current)
    }

    for (const scope of visibleScopes) {
      const element = scopeElementRefs.current[scope]
      if (element) {
        observer.observe(element)
      }
    }

    window.addEventListener('resize', updateHandleOffsets)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHandleOffsets)
    }
  }, [gridTemplateColumns, isEditMode, updateHandleOffsets, visibleScopes])

  useEffect(() => {
    const visibleScopeSet = new Set(visibleScopes)
    audioEngine.setVisualizerConsumerDemand('docked-deck', {
      spectrum: isRunning && visibleScopeSet.has('spectrum') && !scopePopoutState.spectrum,
      oscilloscope: isRunning && visibleScopeSet.has('oscilloscope') && !scopePopoutState.oscilloscope,
      vectorscope: isRunning && visibleScopeSet.has('vectorscope') && !scopePopoutState.vectorscope,
      spectrogram: isRunning && visibleScopeSet.has('spectrogram') && !scopePopoutState.spectrogram,
      vumeter: isRunning && visibleScopeSet.has('vumeter') && !scopePopoutState.vumeter,
      lufsmeter: isRunning && visibleScopeSet.has('lufsmeter') && !scopePopoutState.lufsmeter,
      waveform: isRunning && visibleScopeSet.has('waveform') && !scopePopoutState.waveform,
    })

    return () => {
      audioEngine.clearVisualizerConsumerDemand('docked-deck')
    }
  }, [isRunning, scopePopoutState, visibleScopes])

  const openAnalyzerSettings = useCallback(() => {
    setActiveView('settings')
    setPendingSettingsSection('analyzer')
  }, [setActiveView, setPendingSettingsSection])

  const startResizeDrag = useCallback((handleIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isEditMode) return

    const leftScope = visibleScopes[handleIndex]
    const rightScope = visibleScopes[handleIndex + 1]
    if (!leftScope || !rightScope) return

    const leftElement = scopeElementRefs.current[leftScope]
    const rightElement = scopeElementRefs.current[rightScope]
    if (!leftElement || !rightElement) return

    event.preventDefault()
    event.stopPropagation()

    const leftWidth = leftElement.getBoundingClientRect().width
    const rightWidth = rightElement.getBoundingClientRect().width
    const pairWidth = leftWidth + rightWidth
    if (pairWidth <= 0) return

    const actualWidths = new Map<ScopeKind, number>()
    for (const scope of visibleScopes) {
      const element = scopeElementRefs.current[scope]
      if (element) {
        actualWidths.set(scope, element.getBoundingClientRect().width)
      }
    }

    const scopesWithFlexibleWidths = visibleScopes.filter((scope) => (widthWeights[scope] ?? 0) > 0)
    const totalFlexibleWidth = scopesWithFlexibleWidths.reduce((sum, scope) => sum + (actualWidths.get(scope) ?? 0), 0)
    const totalFlexibleWeight = scopesWithFlexibleWidths.reduce((sum, scope) => sum + (widthWeights[scope] ?? 0), 0)
    const pixelsPerWeight = totalFlexibleWeight > 0 && totalFlexibleWidth > 0
      ? totalFlexibleWidth / totalFlexibleWeight
      : 0

    const effectiveLeftWeight = (widthWeights[leftScope] ?? 0) > 0
      ? widthWeights[leftScope] ?? 1
      : pixelsPerWeight > 0 ? (actualWidths.get(leftScope) ?? leftWidth) / pixelsPerWeight : 1
    const effectiveRightWeight = (widthWeights[rightScope] ?? 0) > 0
      ? widthWeights[rightScope] ?? 1
      : pixelsPerWeight > 0 ? (actualWidths.get(rightScope) ?? rightWidth) / pixelsPerWeight : 1

    const pairWeight = Math.max(MIN_PREVIEW_WEIGHT * 2, effectiveLeftWeight + effectiveRightWeight)

    resizeSessionRef.current = {
      leftScope,
      rightScope,
      startClientX: event.clientX,
      startLeftWidth: leftWidth,
      pairWidth,
      pairWeight,
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const session = resizeSessionRef.current
      if (!session) return

      const deltaX = moveEvent.clientX - session.startClientX
      const nextLeftWidth = Math.min(
        session.pairWidth - scopeMinWidthPx(session.rightScope),
        Math.max(scopeMinWidthPx(session.leftScope), session.startLeftWidth + deltaX)
      )

      const leftRatio = nextLeftWidth / session.pairWidth
      const minLeftWeight = MIN_PREVIEW_WEIGHT
      const maxLeftWeight = Math.min(MAX_PREVIEW_WEIGHT, session.pairWeight - MIN_PREVIEW_WEIGHT)
      const unclampedLeftWeight = session.pairWeight * leftRatio
      const nextLeftWeight = Math.min(maxLeftWeight, Math.max(minLeftWeight, unclampedLeftWeight))
      const nextRightWeight = clampPreviewWeight(session.pairWeight - nextLeftWeight)

      const nextPreviewWeights: Partial<Record<ScopeKind, number>> = {
        [session.leftScope]: clampPreviewWeight(session.pairWeight - nextRightWeight),
        [session.rightScope]: nextRightWeight,
      }

      resizePreviewWeightsRef.current = nextPreviewWeights
      setResizePreviewWeights(nextPreviewWeights)
      onResizePreviewChange?.(nextPreviewWeights)
    }

    const handlePointerUp = () => {
      stopResize(true)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }

    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [isEditMode, onResizePreviewChange, stopResize, visibleScopes, widthWeights])

  const renderScopeItem = (scope: ScopeKind) => {
    const isPoppedOut = scopePopoutState[scope]
    const itemIndex = visibleScopes.indexOf(scope)
    const itemClassName = (() => {
      switch (scope) {
        case 'spectrum':
          return 'visualizer-item visualizer-item-spectrum'
        case 'oscilloscope':
          return 'visualizer-item visualizer-item-scope'
        case 'vectorscope':
          return 'visualizer-item visualizer-item-vector'
        case 'spectrogram':
          return 'visualizer-item visualizer-item-spectrogram'
        case 'vumeter':
          return 'visualizer-item visualizer-item-vumeter'
        case 'lufsmeter':
          return 'visualizer-item visualizer-item-lufsmeter'
        case 'waveform':
          return 'visualizer-item visualizer-item-waveform'
      }
    })()

    const captionRight = (() => {
      if (isPoppedOut) return 'POPPED OUT'
      switch (scope) {
        case 'spectrum':
          return `FFT ${fftSize}`
        case 'oscilloscope':
          return pitchLock ? 'PITCH-LOCK' : 'FREE-RUN'
        case 'vectorscope':
          return isRunning ? vectorscopeModeLabelShort(vectorscopeMode) : 'PAUSED'
        case 'spectrogram':
          return `${spectrogramScaleLabelShort(spectrogramScaleMode)} ${spectrogramClarityLabelShort(spectrogramClarityMode)} X${spectrogramScrollSpeed.toFixed(1)}`
        case 'vumeter':
          return vuMeterMode === 'needle' ? 'NEEDLE' : 'BAR'
        case 'lufsmeter':
          return 'LUFS'
        case 'waveform':
          return waveformMultiband ? `RGB X${waveformScrollSpeed.toFixed(1)}` : `SPEED X${waveformScrollSpeed.toFixed(1)}`
      }
    })()

    return (
      <div
        key={scope}
        ref={(element) => {
          scopeElementRefs.current[scope] = element
        }}
        className={[
          itemClassName,
          isPoppedOut ? 'is-popped-out' : '',
          isEditMode ? 'is-edit-mode' : '',
          isEditMode && highlightedScope === scope ? 'is-linked-highlight' : '',
          draggedScope === scope ? 'is-dragging' : '',
          rackDropIndex === itemIndex ? 'is-drop-before' : '',
          rackDropIndex === itemIndex + 1 ? 'is-drop-after' : '',
        ].filter(Boolean).join(' ')}
        draggable={isEditMode}
        onDragStart={isEditMode && onRackScopeDragStart
          ? (event) => onRackScopeDragStart(scope, false, event)
          : undefined}
        onDragOver={isEditMode && onRackScopeDragOver
          ? (event) => onRackScopeDragOver(itemIndex, event)
          : undefined}
        onDrop={isEditMode && onRackScopeDrop
          ? (event) => onRackScopeDrop(event)
          : undefined}
        onDragEnd={isEditMode && onRackScopeDragEnd
          ? () => onRackScopeDragEnd()
          : undefined}
        onMouseEnter={isEditMode && onScopeHoverChange
          ? () => onScopeHoverChange(scope)
          : undefined}
        onClick={isEditMode && onScopeActivate
          ? () => onScopeActivate(scope)
          : undefined}
      >
        <div className="visualizer-caption-left">{scopeLabel(scope).toUpperCase()}</div>
        <div className="visualizer-caption-right-group">
          <div className="visualizer-caption-right">{captionRight}</div>
          {!isPoppedOut && !isEditMode && (
            <button
              className="visualizer-popout-btn"
              onClick={() => openScopePopout(scope)}
              title={`Pop out ${scopeLabel(scope).toLowerCase()}`}
              aria-label={`Pop out ${scopeLabel(scope).toLowerCase()}`}
            >
              Pop
            </button>
          )}
        </div>
        {isPoppedOut ? (
          <PopoutPlaceholder scope={scope} onRecall={() => recallScopePopout(scope)} />
        ) : scope === 'spectrum' ? (
          <DockedSpectrumTile
            lineColor={lineColor}
            fftSize={fftSize}
            isRunning={isRunning}
          />
        ) : scope === 'oscilloscope' ? (
          <DockedOscilloscopeTile
            lineColor={lineColor}
            pitchLock={pitchLock}
            underfillEnabled={oscilloscopeUnderfillEnabled}
            isRunning={isRunning}
          />
        ) : scope === 'spectrogram' ? (
          <DockedSpectrogramTile
            lineColor={lineColor}
            fftSize={spectrogramFftSize}
            scrollSpeed={spectrogramScrollSpeed}
            clarityMode={spectrogramClarityMode}
            scaleMode={spectrogramScaleMode}
            isRunning={isRunning}
          />
        ) : scope === 'vumeter' ? (
          <DockedVUMeterTile
            lineColor={lineColor}
            vuMeterMode={vuMeterMode}
            isRunning={isRunning}
          />
        ) : scope === 'lufsmeter' ? (
          <DockedLUFSMeterTile
            lineColor={lineColor}
            isRunning={isRunning}
          />
        ) : scope === 'waveform' ? (
          <DockedWaveformTile
            lineColor={lineColor}
            scrollSpeed={waveformScrollSpeed}
            multiband={waveformMultiband}
            isRunning={isRunning}
          />
        ) : (
          <DockedVectorscopeTile
            lineColor={lineColor}
            vectorscopeMode={vectorscopeMode}
            vectorscopeMultiband={vectorscopeMultiband}
            isRunning={isRunning}
          />
        )}
      </div>
    )
  }

  return (
    <div className={`visualizer-panel ${className}`}>
      <div
        ref={gridRef}
        className={[
          'visualizer-grid',
          visibleScopes.length === 0 ? 'is-empty' : '',
          isEditMode ? 'is-edit-mode' : '',
        ].filter(Boolean).join(' ')}
        style={gridTemplateColumns ? { gridTemplateColumns } : undefined}
        onDragOver={visibleScopes.length === 0 && isEditMode && onRackEmptyDragOver
          ? (event) => onRackEmptyDragOver(event)
          : undefined}
        onDrop={visibleScopes.length === 0 && isEditMode && onRackEmptyDrop
          ? (event) => onRackEmptyDrop(event)
          : undefined}
      >
        {visibleScopes.length > 0 ? (
          <>
            {visibleScopes.map(renderScopeItem)}
            {isEditMode && draggedScope === null && visibleScopes.length > 1 && handleOffsets.map((offset, index) => (
              <button
                key={`${visibleScopes[index]}:${visibleScopes[index + 1]}`}
                type="button"
                className="visualizer-resize-handle"
                style={{ left: `${offset}px` }}
                onPointerDown={(event) => startResizeDrag(index, event)}
                aria-label={`Resize between ${scopeLabel(visibleScopes[index])} and ${scopeLabel(visibleScopes[index + 1])}`}
              >
                <span className="visualizer-resize-handle-grip" aria-hidden="true" />
              </button>
            ))}
          </>
        ) : (
          <div className="visualizer-empty-state">
            {isEditMode ? (
              <>
                <div className="visualizer-empty-state-title">Rack is empty</div>
                <div className="visualizer-empty-state-copy">Drag a stashed scope into the rack to bring it back.</div>
              </>
            ) : (
              <>
                <div className="visualizer-empty-state-title">All docked scopes are hidden</div>
                <div className="visualizer-empty-state-copy">Restore them from Settings → Analyzer.</div>
                <button
                  type="button"
                  className="visualizer-empty-state-btn"
                  onClick={openAnalyzerSettings}
                >
                  Open Analyzer Settings
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
