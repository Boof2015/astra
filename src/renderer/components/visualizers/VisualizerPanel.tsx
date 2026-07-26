import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { audioEngine } from '../../audio/AudioEngine'
import { LUFSMeter, Oscilloscope, SpectrumAnalyzer, Spectrogram, Vectorscope, VUMeter, Waveform } from '../../audio/visualizers'
import { FrameScheduler } from '../../audio/visualizers/frameScheduler'
import { getNativeLoadError, isNativeAvailable } from '../../audio/native/index'
import { isNativeOnlyScope } from './nativeOnlyScopes'
import { buildAnalyzerGridTemplateColumns } from '../layout/analyzerLayout'
import { useScopePopoutStore } from '../../stores/scopePopoutStore'
import { useThemeStore } from '../../stores/themeStore'
import { useVisualizerSettingsStore, type VectorscopeMode } from '../../stores/visualizerSettingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useBufferedCanvasResize } from '../../hooks/useBufferedCanvasResize'
import type { ScopeKind } from '../../../types/scopePopout'
import type { SpectrogramClarityMode, SpectrogramScaleMode, SpectrogramOrientation } from '../../../types/spectrogram'
import type { SpectrumDisplayMode } from '../../../types/spectrum'
import type { VUMeterMode, VUMeterOrientation } from '../../../types/vumeter'
import type { WaveformMode } from '../../../types/waveform'
import { resolveSpectrumHeatColors } from '../../audio/visualizers/spectrumHeatPalette'

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

interface VisualizerDisplayColors {
  backgroundColor: string
  gridColor: string
  gridMutedColor: string
  meterTickColor: string
  meterTextColor: string
}

const MIN_SCOPE_WIDTH_PX = 112
const MIN_VECTORSCOPE_DRAWABLE_WIDTH_PX = 96
const MIN_LISSAJOUS_VECTORSCOPE_TILE_WIDTH_PX = 152
const MIN_PREVIEW_WEIGHT = 0.4
const MAX_PREVIEW_WEIGHT = 2.6
const EMPTY_VISIBLE_SCOPES: ScopeKind[] = []

function parseCssPixelValue(value: string): number | null {
  const numeric = Number.parseFloat(value)
  return Number.isFinite(numeric) ? numeric : null
}

function resolveAnalyzerHeightPx(referenceElement: HTMLElement | null): number | null {
  if (!referenceElement) return null

  const value = getComputedStyle(referenceElement).getPropertyValue('--analyzer-height')
  return parseCssPixelValue(value)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function vectorscopeMinWidthPx(vectorscopeMode: VectorscopeMode, referenceElement: HTMLElement | null): number {
  if (vectorscopeMode === 'lissajous') {
    return MIN_LISSAJOUS_VECTORSCOPE_TILE_WIDTH_PX
  }

  const analyzerHeightPx = resolveAnalyzerHeightPx(referenceElement)
  const squareBiasedMaxWidth = analyzerHeightPx === null
    ? MIN_VECTORSCOPE_DRAWABLE_WIDTH_PX
    : Math.max(MIN_VECTORSCOPE_DRAWABLE_WIDTH_PX, analyzerHeightPx - 8)

  return Math.round(clampNumber(
    window.innerWidth * 0.18,
    MIN_VECTORSCOPE_DRAWABLE_WIDTH_PX,
    squareBiasedMaxWidth
  ))
}

function scopeMinWidthPx(
  scope: ScopeKind,
  vectorscopeMode: VectorscopeMode,
  referenceElement: HTMLElement | null
): number {
  return scope === 'vectorscope'
    ? vectorscopeMinWidthPx(vectorscopeMode, referenceElement)
    : MIN_SCOPE_WIDTH_PX
}

function clampPreviewWeight(value: number): number {
  if (!Number.isFinite(value)) return 1
  const normalized = Math.round(value * 100) / 100
  return Math.min(MAX_PREVIEW_WEIGHT, Math.max(MIN_PREVIEW_WEIGHT, normalized))
}

function hasRenderedBox(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return false
  }

  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.opacity === '0'
    ) {
      return false
    }
  }

  return true
}

function useAnalyzerSurfaceVisible(
  panelRef: RefObject<HTMLDivElement | null>
): boolean {
  const [isSurfaceVisible, setIsSurfaceVisible] = useState(() => {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  })

  const updateSurfaceVisible = useCallback(() => {
    if (document.visibilityState === 'hidden') {
      setIsSurfaceVisible(false)
      return
    }

    const panel = panelRef.current
    if (!panel) {
      setIsSurfaceVisible(true)
      return
    }

    setIsSurfaceVisible(hasRenderedBox(panel))
  }, [panelRef])

  useEffect(() => {
    updateSurfaceVisible()
  }, [updateSurfaceVisible])

  useEffect(() => {
    const panel = panelRef.current
    const observer = typeof ResizeObserver === 'undefined' || !panel
      ? null
      : new ResizeObserver(() => updateSurfaceVisible())

    if (observer && panel) {
      observer.observe(panel)
    }
    window.addEventListener('resize', updateSurfaceVisible)
    document.addEventListener('visibilitychange', updateSurfaceVisible)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateSurfaceVisible)
      document.removeEventListener('visibilitychange', updateSurfaceVisible)
    }
  }, [panelRef, updateSurfaceVisible])

  return isSurfaceVisible
}

function DockedSpectrumTile({
  lineColor,
  displayColors,
  fftSize,
  displayMode,
  tiltDbPerOctave,
  heatmapFill,
  heatmapTiltDbPerOctave,
  showSideLine,
  smoothing,
  heatmapSmoothing,
  heatColors,
  barDensity,
  barGapPercent,
  barCornerRadiusPx,
  showBarPeaks,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  fftSize: number
  displayMode: SpectrumDisplayMode
  tiltDbPerOctave: number
  heatmapFill: boolean
  heatmapTiltDbPerOctave: number
  showSideLine: boolean
  smoothing: number
  heatmapSmoothing: number
  heatColors: [string, string, string]
  barDensity: number
  barGapPercent: number
  barCornerRadiusPx: number
  showBarPeaks: boolean
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<SpectrumAnalyzer | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new SpectrumAnalyzer(canvasRef.current, {
        frameScheduler,
        lineColor,
        backgroundColor: displayColors.backgroundColor,
        gridColor: displayColors.gridColor,
        lineWidth: 2,
        fillGradient: !heatmapFill,
        heatmapFill,
        tiltDbPerOctave,
        heatmapTiltDbPerOctave,
        fftSize,
        displayMode,
        showSideLine,
        smoothing,
        heatmapSmoothing,
        heatColors,
        barDensity,
        barGapPercent,
        barCornerRadiusPx,
        showBarPeaks,
        secondaryLineColor: 'rgba(255, 255, 255, 0.42)',
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
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      backgroundColor: displayColors.backgroundColor,
      gridColor: displayColors.gridColor,
      fftSize,
      displayMode,
      showSideLine,
      smoothing,
      heatmapSmoothing,
      heatColors,
      barDensity,
      barGapPercent,
      barCornerRadiusPx,
      showBarPeaks,
      fillGradient: !heatmapFill,
      heatmapFill,
      tiltDbPerOctave,
      heatmapTiltDbPerOctave,
      gradientColors: [
        'rgba(0, 255, 255, 0)',
        `${lineColor}33`,
        `${lineColor}66`
      ]
    })
  }, [displayColors, lineColor, fftSize, displayMode, heatmapFill, tiltDbPerOctave, heatmapTiltDbPerOctave, showSideLine, smoothing, heatmapSmoothing, heatColors, barDensity, barGapPercent, barCornerRadiusPx, showBarPeaks])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedOscilloscopeTile({
  lineColor,
  displayColors,
  pitchLock,
  underfillEnabled,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  pitchLock: boolean
  underfillEnabled: boolean
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Oscilloscope | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Oscilloscope(canvasRef.current, {
        frameScheduler,
        lineColor,
        backgroundColor: displayColors.backgroundColor,
        gridMajorColor: displayColors.gridColor,
        gridMinorColor: displayColors.gridMutedColor,
        lineWidth: 2,
        pitchLock,
        underfillEnabled,
        showGrid: true
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      backgroundColor: displayColors.backgroundColor,
      gridMajorColor: displayColors.gridColor,
      gridMinorColor: displayColors.gridMutedColor,
      pitchLock,
      underfillEnabled,
    })
  }, [displayColors, lineColor, pitchLock, underfillEnabled])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedVectorscopeTile({
  lineColor,
  displayColors,
  vectorscopeMode,
  vectorscopeMultiband,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  vectorscopeMode: VectorscopeMode
  vectorscopeMultiband: boolean
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Vectorscope | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Vectorscope(canvasRef.current, {
        frameScheduler,
        lineColor,
        backgroundColor: displayColors.backgroundColor,
        gridMajorColor: displayColors.gridColor,
        gridMinorColor: displayColors.gridMutedColor,
        lineWidth: 1,
        showGrid: true,
        mode: vectorscopeMode,
        multiband: vectorscopeMultiband,
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      backgroundColor: displayColors.backgroundColor,
      gridMajorColor: displayColors.gridColor,
      gridMinorColor: displayColors.gridMutedColor,
      mode: vectorscopeMode,
      multiband: vectorscopeMultiband,
    })
  }, [displayColors, lineColor, vectorscopeMode, vectorscopeMultiband])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedSpectrogramTile({
  lineColor,
  displayColors,
  fftSize,
  scrollSpeed,
  clarityMode,
  scaleMode,
  tiltDbPerOctave,
  contrast,
  orientation,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  fftSize: number
  scrollSpeed: number
  clarityMode: SpectrogramClarityMode
  scaleMode: SpectrogramScaleMode
  tiltDbPerOctave: number
  contrast: number
  orientation: SpectrogramOrientation
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Spectrogram | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Spectrogram(canvasRef.current, {
        frameScheduler,
        lineColor,
        backgroundColor: displayColors.backgroundColor,
        fftSize,
        scrollSpeed,
        clarityMode,
        scaleMode,
        tiltDbPerOctave,
        contrast,
        orientation,
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      backgroundColor: displayColors.backgroundColor,
      fftSize,
      scrollSpeed,
      clarityMode,
      scaleMode,
      tiltDbPerOctave,
      contrast,
      orientation,
    })
  }, [clarityMode, displayColors, lineColor, fftSize, scrollSpeed, scaleMode, tiltDbPerOctave, contrast, orientation])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedVUMeterTile({
  lineColor,
  displayColors,
  vuMeterMode,
  vuMeterOrientation,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  vuMeterMode: VUMeterMode
  vuMeterOrientation: VUMeterOrientation
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<VUMeter | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new VUMeter(canvasRef.current, {
        frameScheduler,
        lineColor,
        backgroundColor: displayColors.backgroundColor,
        scaleColor: displayColors.meterTickColor,
        labelColor: displayColors.meterTextColor,
        needleLeftColor: lineColor,
        needleRightColor: lineColor,
        needleCombinedColor: lineColor,
        mode: vuMeterMode,
        orientation: vuMeterOrientation,
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      backgroundColor: displayColors.backgroundColor,
      scaleColor: displayColors.meterTickColor,
      labelColor: displayColors.meterTextColor,
      needleLeftColor: lineColor,
      needleRightColor: lineColor,
      needleCombinedColor: lineColor,
      mode: vuMeterMode,
      orientation: vuMeterOrientation,
    })
  }, [displayColors, lineColor, vuMeterMode, vuMeterOrientation])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedLUFSMeterTile({
  lineColor,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<LUFSMeter | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new LUFSMeter(canvasRef.current, {
        frameScheduler,
        lineColor,
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

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

  return (
    <div ref={containerRef} className="visualizer-surface">
      <canvas ref={canvasRef} className="visualizer-canvas" />
    </div>
  )
}

function DockedWaveformTile({
  lineColor,
  displayColors,
  scrollSpeed,
  gainDb,
  multiband,
  mode,
  isRunning,
  frameScheduler,
}: {
  lineColor: string
  displayColors: VisualizerDisplayColors
  scrollSpeed: number
  gainDb: number
  multiband: boolean
  mode: WaveformMode
  isRunning: boolean
  frameScheduler: FrameScheduler
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Waveform | null>(null)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Waveform(canvasRef.current, {
        frameScheduler,
        lineColor,
        gridMajorColor: displayColors.gridColor,
        gridMinorColor: displayColors.gridMutedColor,
        scrollSpeed,
        gainDb,
        multiband,
        mode,
      })
    }

    if (isRunning) {
      visualizerRef.current?.start()
    }
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
    }
  }, [applyResizeNow, frameScheduler])

  useEffect(() => {
    visualizerRef.current?.setOptions({
      lineColor,
      gridMajorColor: displayColors.gridColor,
      gridMinorColor: displayColors.gridMutedColor,
      scrollSpeed,
      gainDb,
      multiband,
      mode,
    })
  }, [displayColors, lineColor, scrollSpeed, gainDb, multiband, mode])

  useEffect(() => {
    if (isRunning) {
      visualizerRef.current?.start()
    } else {
      visualizerRef.current?.stop()
    }
  }, [isRunning])

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

function vuMeterLabelShort(mode: VUMeterMode, orientation: VUMeterOrientation): string {
  if (mode === 'needle') return 'NEEDLE'
  return orientation === 'vertical' ? 'BAR VERT' : 'BAR HORZ'
}

function spectrumDisplayModeLabelShort(mode: SpectrumDisplayMode): string {
  return mode === 'bars' ? 'BARS' : 'CURVE'
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

function NativeUnavailableNotice({
  scope,
  reason,
}: {
  scope: ScopeKind
  reason: string | null
}) {
  return (
    <div className="visualizer-native-unavailable" title={reason ?? undefined}>
      <div className="visualizer-native-unavailable-glyph" aria-hidden="true">⚠</div>
      <div className="visualizer-native-unavailable-title">Native DSP unavailable</div>
      <div className="visualizer-native-unavailable-copy">
        {scopeLabel(scope)} needs Astra&apos;s native audio module, which didn&apos;t load in this build.
      </div>
      {reason ? (
        <div className="visualizer-native-unavailable-reason">{reason}</div>
      ) : null}
      <div className="visualizer-native-unavailable-hint">
        Likely a packaging issue — reinstall an official build or report this message.
      </div>
    </div>
  )
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
  const frameScheduler = useMemo(() => new FrameScheduler(), [])
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const visualizerTheme = useThemeStore((s) => s.resolvedTokens)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const spectrogramFftSize = useVisualizerSettingsStore((s) => s.spectrogramFftSize)
  const spectrogramScrollSpeed = useVisualizerSettingsStore((s) => s.spectrogramScrollSpeed)
  const spectrogramClarityMode = useVisualizerSettingsStore((s) => s.spectrogramClarityMode)
  const spectrogramScaleMode = useVisualizerSettingsStore((s) => s.spectrogramScaleMode)
  const spectrogramTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrogramTiltDbPerOctave)
  const spectrogramContrast = useVisualizerSettingsStore((s) => s.spectrogramContrast)
  const spectrogramOrientation = useVisualizerSettingsStore((s) => s.spectrogramOrientation)
  const spectrumHeatmap = useVisualizerSettingsStore((s) => s.spectrumHeatmap)
  const spectrumShowSideLine = useVisualizerSettingsStore((s) => s.spectrumShowSideLine)
  const spectrumSmoothing = useVisualizerSettingsStore((s) => s.spectrumSmoothing)
  const spectrumHeatmapSmoothing = useVisualizerSettingsStore((s) => s.spectrumHeatmapSmoothing)
  const spectrumDisplayMode = useVisualizerSettingsStore((s) => s.spectrumDisplayMode)
  const spectrumTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrumTiltDbPerOctave)
  const spectrumHeatmapTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrumHeatmapTiltDbPerOctave)
  const spectrumBarDensity = useVisualizerSettingsStore((s) => s.spectrumBarDensity)
  const spectrumBarGapPercent = useVisualizerSettingsStore((s) => s.spectrumBarGapPercent)
  const spectrumBarCornerRadiusPx = useVisualizerSettingsStore((s) => s.spectrumBarCornerRadiusPx)
  const spectrumShowBarPeaks = useVisualizerSettingsStore((s) => s.spectrumShowBarPeaks)
  const spectrumHeatPalette = useVisualizerSettingsStore((s) => s.spectrumHeatPalette)
  const waveformScrollSpeed = useVisualizerSettingsStore((s) => s.waveformScrollSpeed)
  const waveformGainDb = useVisualizerSettingsStore((s) => s.waveformGainDb)
  const waveformMultiband = useVisualizerSettingsStore((s) => s.waveformMultiband)
  const waveformMode = useVisualizerSettingsStore((s) => s.waveformMode)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const isRunning = useVisualizerSettingsStore((s) => s.isRunning)
  const vectorscopeMode = useVisualizerSettingsStore((s) => s.vectorscopeMode)
  const vectorscopeMultiband = useVisualizerSettingsStore((s) => s.vectorscopeMultiband)
  const vuMeterMode = useVisualizerSettingsStore((s) => s.vuMeterMode)
  const vuMeterOrientation = useVisualizerSettingsStore((s) => s.vuMeterOrientation)
  const scopeOrder = useVisualizerSettingsStore((s) => s.scopeOrder)
  const hiddenScopes = useVisualizerSettingsStore((s) => s.hiddenScopes)
  const widthWeights = useVisualizerSettingsStore((s) => s.widthWeights)
  const setScopeWidthWeights = useVisualizerSettingsStore((s) => s.setScopeWidthWeights)
  const scopePopoutState = useScopePopoutStore((s) => s.state)
  const openAnalyzerEditMode = useUIStore((s) => s.openAnalyzerEditMode)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const panelRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const scopeElementRefs = useRef<Partial<Record<ScopeKind, HTMLDivElement | null>>>({})
  const resizeSessionRef = useRef<ResizeSession | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const resizePreviewWeightsRef = useRef<Partial<Record<ScopeKind, number>> | null>(null)
  const [resizePreviewWeights, setResizePreviewWeights] = useState<Partial<Record<ScopeKind, number>> | null>(null)
  const [handleOffsets, setHandleOffsets] = useState<number[]>([])
  const displayColors = useMemo<VisualizerDisplayColors>(() => ({
    backgroundColor: visualizerTheme.stageBg,
    gridColor: visualizerTheme.stageGrid,
    gridMutedColor: visualizerTheme.isLight ? 'rgba(15, 23, 42, 0.07)' : 'rgba(255, 255, 255, 0.04)',
    meterTickColor: visualizerTheme.stageGrid,
    meterTextColor: visualizerTheme.stageText,
  }), [visualizerTheme])
  const spectrumHeatColors = useMemo(
    () => resolveSpectrumHeatColors(
      spectrumHeatPalette,
      lineColor,
      visualizerTheme.stageBg,
      visualizerTheme.isLight,
    ),
    [lineColor, spectrumHeatPalette, visualizerTheme.isLight, visualizerTheme.stageBg],
  )

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
  const isAnalyzerSurfaceVisible = useAnalyzerSurfaceVisible(panelRef)
  const isDockedAnalyzerActive = isAnalyzerSurfaceVisible && !isFullscreen
  const nativeVisualizersAvailable = isNativeAvailable()
  const mountedVisibleScopes = isAnalyzerSurfaceVisible ? visibleScopes : EMPTY_VISIBLE_SCOPES

  const effectiveWidthWeights = useMemo(() => {
    if (!resizePreviewWeights) return widthWeights
    return {
      ...widthWeights,
      ...resizePreviewWeights,
    }
  }, [resizePreviewWeights, widthWeights])

  const derivedGridTemplateColumns = useMemo(() => {
    return buildAnalyzerGridTemplateColumns(visibleScopes, effectiveWidthWeights, vectorscopeMode)
  }, [effectiveWidthWeights, vectorscopeMode, visibleScopes])
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
    if (isAnalyzerSurfaceVisible) return
    stopResize(false)
  }, [isAnalyzerSurfaceVisible, stopResize])

  useEffect(() => {
    if (!isFullscreen) return
    stopResize(false)
  }, [isFullscreen, stopResize])

  useEffect(() => {
    stopResize(false)
  }, [mountedVisibleScopes.length, stopResize])

  const updateHandleOffsets = useCallback(() => {
    if (!isDockedAnalyzerActive || !isEditMode || mountedVisibleScopes.length < 2) {
      setHandleOffsets([])
      return
    }

    const nextOffsets: number[] = []
    for (let index = 0; index < mountedVisibleScopes.length - 1; index += 1) {
      const leftElement = scopeElementRefs.current[mountedVisibleScopes[index]]
      if (!leftElement) continue
      nextOffsets.push(leftElement.offsetLeft + leftElement.offsetWidth)
    }
    setHandleOffsets(nextOffsets)
  }, [isDockedAnalyzerActive, isEditMode, mountedVisibleScopes])

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

    for (const scope of mountedVisibleScopes) {
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
  }, [gridTemplateColumns, isEditMode, mountedVisibleScopes, updateHandleOffsets])

  useEffect(() => {
    const visibleScopeSet = new Set(mountedVisibleScopes)
    const spectrumDemand = nativeVisualizersAvailable && isDockedAnalyzerActive && isRunning && visibleScopeSet.has('spectrum') && !scopePopoutState.spectrum
    const waveformDemand = isDockedAnalyzerActive && isRunning && visibleScopeSet.has('waveform') && !scopePopoutState.waveform
    audioEngine.setVisualizerConsumerDemand('docked-deck', {
      spectrum: spectrumDemand,
      spectrumStereo: spectrumDemand && spectrumShowSideLine,
      oscilloscope: nativeVisualizersAvailable && isDockedAnalyzerActive && isRunning && visibleScopeSet.has('oscilloscope') && !scopePopoutState.oscilloscope,
      vectorscope: isDockedAnalyzerActive && isRunning && visibleScopeSet.has('vectorscope') && !scopePopoutState.vectorscope,
      spectrogram: isDockedAnalyzerActive && isRunning && visibleScopeSet.has('spectrogram') && !scopePopoutState.spectrogram,
      vumeter: isDockedAnalyzerActive && isRunning && visibleScopeSet.has('vumeter') && !scopePopoutState.vumeter,
      lufsmeter: isDockedAnalyzerActive && isRunning && visibleScopeSet.has('lufsmeter') && !scopePopoutState.lufsmeter,
      waveform: waveformDemand,
      waveformStereo: waveformDemand && waveformMode === 'stereo',
    })

    return () => {
      audioEngine.clearVisualizerConsumerDemand('docked-deck')
    }
  }, [isDockedAnalyzerActive, isRunning, mountedVisibleScopes, nativeVisualizersAvailable, scopePopoutState, spectrumShowSideLine, waveformMode])

  const openScopeEditor = useCallback(() => {
    openAnalyzerEditMode()
  }, [openAnalyzerEditMode])

  const startResizeDrag = useCallback((handleIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isDockedAnalyzerActive || !isEditMode) return

    const leftScope = mountedVisibleScopes[handleIndex]
    const rightScope = mountedVisibleScopes[handleIndex + 1]
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
    for (const scope of mountedVisibleScopes) {
      const element = scopeElementRefs.current[scope]
      if (element) {
        actualWidths.set(scope, element.getBoundingClientRect().width)
      }
    }

    const scopesWithFlexibleWidths = mountedVisibleScopes.filter((scope) => (widthWeights[scope] ?? 0) > 0)
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
      const minRightWidth = scopeMinWidthPx(session.rightScope, vectorscopeMode, gridRef.current)
      const minLeftWidth = scopeMinWidthPx(session.leftScope, vectorscopeMode, gridRef.current)
      const nextLeftWidth = Math.min(
        session.pairWidth - minRightWidth,
        Math.max(minLeftWidth, session.startLeftWidth + deltaX)
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
  }, [isDockedAnalyzerActive, isEditMode, mountedVisibleScopes, onResizePreviewChange, stopResize, widthWeights])

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
          return `${spectrumDisplayModeLabelShort(spectrumDisplayMode)} · FFT ${fftSize}`
        case 'oscilloscope':
          return pitchLock ? 'PITCH-LOCK' : 'FREE-RUN'
        case 'vectorscope':
          return isRunning ? vectorscopeModeLabelShort(vectorscopeMode) : 'PAUSED'
        case 'spectrogram':
          return `${spectrogramScaleLabelShort(spectrogramScaleMode)} ${spectrogramClarityLabelShort(spectrogramClarityMode)} X${spectrogramScrollSpeed.toFixed(1)}`
        case 'vumeter':
          return vuMeterLabelShort(vuMeterMode, vuMeterOrientation)
        case 'lufsmeter':
          return 'LUFS'
        case 'waveform': {
          const modeTag = waveformMode === 'stereo' ? 'STEREO' : 'MONO'
          const rgbTag = waveformMultiband ? 'RGB ' : ''
          return `${modeTag} ${rgbTag}X${waveformScrollSpeed.toFixed(1)}`
        }
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
        ) : !nativeVisualizersAvailable && isNativeOnlyScope(scope) ? (
          <NativeUnavailableNotice scope={scope} reason={getNativeLoadError()?.message ?? null} />
        ) : scope === 'spectrum' ? (
          <DockedSpectrumTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            fftSize={fftSize}
            displayMode={spectrumDisplayMode}
            tiltDbPerOctave={spectrumTiltDbPerOctave}
            heatmapFill={spectrumHeatmap}
            heatmapTiltDbPerOctave={spectrumHeatmapTiltDbPerOctave}
            showSideLine={spectrumShowSideLine}
            smoothing={spectrumSmoothing}
            heatmapSmoothing={spectrumHeatmapSmoothing}
            heatColors={spectrumHeatColors}
            barDensity={spectrumBarDensity}
            barGapPercent={spectrumBarGapPercent}
            barCornerRadiusPx={spectrumBarCornerRadiusPx}
            showBarPeaks={spectrumShowBarPeaks}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : scope === 'oscilloscope' ? (
          <DockedOscilloscopeTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            pitchLock={pitchLock}
            underfillEnabled={oscilloscopeUnderfillEnabled}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : scope === 'spectrogram' ? (
          <DockedSpectrogramTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            fftSize={spectrogramFftSize}
            scrollSpeed={spectrogramScrollSpeed}
            clarityMode={spectrogramClarityMode}
            scaleMode={spectrogramScaleMode}
            tiltDbPerOctave={spectrogramTiltDbPerOctave}
            contrast={spectrogramContrast}
            orientation={spectrogramOrientation}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : scope === 'vumeter' ? (
          <DockedVUMeterTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            vuMeterMode={vuMeterMode}
            vuMeterOrientation={vuMeterOrientation}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : scope === 'lufsmeter' ? (
          <DockedLUFSMeterTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : scope === 'waveform' ? (
          <DockedWaveformTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            scrollSpeed={waveformScrollSpeed}
            gainDb={waveformGainDb}
            multiband={waveformMultiband}
            mode={waveformMode}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        ) : (
          <DockedVectorscopeTile
            frameScheduler={frameScheduler}
            lineColor={lineColor}
            displayColors={displayColors}
            vectorscopeMode={vectorscopeMode}
            vectorscopeMultiband={vectorscopeMultiband}
            isRunning={isDockedAnalyzerActive && isRunning}
          />
        )}
      </div>
    )
  }

  return (
    <div ref={panelRef} className={`visualizer-panel ${className}`}>
      <div
        ref={gridRef}
        className={[
          'visualizer-grid',
          isAnalyzerSurfaceVisible && visibleScopes.length === 0 ? 'is-empty' : '',
          isEditMode ? 'is-edit-mode' : '',
        ].filter(Boolean).join(' ')}
        style={isAnalyzerSurfaceVisible && gridTemplateColumns ? { gridTemplateColumns } : undefined}
        onDragOver={isAnalyzerSurfaceVisible && visibleScopes.length === 0 && isEditMode && onRackEmptyDragOver
          ? (event) => onRackEmptyDragOver(event)
          : undefined}
        onDrop={isAnalyzerSurfaceVisible && visibleScopes.length === 0 && isEditMode && onRackEmptyDrop
          ? (event) => onRackEmptyDrop(event)
          : undefined}
      >
        {!isAnalyzerSurfaceVisible ? null : visibleScopes.length > 0 ? (
          <>
            {mountedVisibleScopes.map(renderScopeItem)}
            {isEditMode && draggedScope === null && mountedVisibleScopes.length > 1 && handleOffsets.map((offset, index) => (
              <button
                key={`${mountedVisibleScopes[index]}:${mountedVisibleScopes[index + 1]}`}
                type="button"
                className="visualizer-resize-handle"
                style={{ left: `${offset}px` }}
                onPointerDown={(event) => startResizeDrag(index, event)}
                aria-label={`Resize between ${scopeLabel(mountedVisibleScopes[index])} and ${scopeLabel(mountedVisibleScopes[index + 1])}`}
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
                <div className="visualizer-empty-state-copy">Open the scope editor to drag stashed scopes back into the rack.</div>
                <button
                  type="button"
                  className="visualizer-empty-state-btn"
                  onClick={openScopeEditor}
                >
                  Open Scope Editor
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
