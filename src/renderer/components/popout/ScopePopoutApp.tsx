import { useEffect, useMemo, useRef } from 'react'
import { LUFSMeter, Oscilloscope, SpectrumAnalyzer, Spectrogram, Vectorscope, VUMeter, Waveform } from '../../audio/visualizers'
import { createMonoSampleQueue, createStereoSampleQueue } from '../../audio/visualizerSampleQueue'
import { nominalFrequencyBoundsForRange, normalizeFrequencyScaleMode, normalizeFrequencyRangeMode, type FrequencyScaleMode, type FrequencyRangeMode } from '../../../types/frequencyScale'
import { normalizeVectorscopeZoomDb } from '../../../types/vectorscope'
import {
  isScopeKind,
  type ScopeKind,
} from '../../../types/scopePopout'
import type { MultichannelAudioChunk } from '../../../types/audioAnalysis'
import {
  DEFAULT_SPECTROGRAM_CLARITY_MODE,
  DEFAULT_SPECTROGRAM_SCALE_MODE,
  DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTROGRAM_CONTRAST,
  DEFAULT_SPECTROGRAM_ORIENTATION,
  clampSpectrogramScrollSpeed,
  clampSpectrogramTiltDbPerOctave,
  clampSpectrogramContrast,
  isSpectrogramClarityMode,
  isSpectrogramScaleMode,
  isSpectrogramOrientation,
} from '../../../types/spectrogram'
import {
  DEFAULT_VU_METER_MODE,
  DEFAULT_VU_METER_ORIENTATION,
  isVUMeterMode,
  isVUMeterOrientation,
  type VUMeterMode,
  type VUMeterOrientation,
} from '../../../types/vumeter'
import {
  DEFAULT_WAVEFORM_GAIN_DB,
  DEFAULT_WAVEFORM_SCROLL_SPEED,
  clampWaveformGainDb,
  clampWaveformScrollSpeed,
} from '../../../types/waveform'
import {
  DEFAULT_SPECTRUM_DISPLAY_MODE,
  DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_BAR_DENSITY,
  DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
  DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
  DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
  isSpectrumDisplayMode,
  type SpectrumDisplayMode,
} from '../../../types/spectrum'
import {
  DEFAULT_SPECTRUM_HEATMAP_SMOOTHING,
  DEFAULT_SPECTRUM_SMOOTHING,
  isVectorscopeMode,
} from '../../stores/visualizerSettingsStore'
import { CLASSIC_SPECTRUM_HEAT_COLORS } from '../../audio/visualizers/spectrumHeatPalette'
import { useBufferedCanvasResize } from '../../hooks/useBufferedCanvasResize'
import '../../styles/scope-popout.css'

const DEFAULT_SPECTRUM_LINE_COLOR = '#38bdf8'
const DEFAULT_SPECTRUM_FFT_SIZE = 4096

function getScopeLabel(scope: ScopeKind): string {
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

function getSpectrumGradientColors(lineColor: string): string[] {
  return ['rgba(0, 255, 255, 0)', `${lineColor}33`, `${lineColor}66`]
}

function SpectrumScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<SpectrumAnalyzer | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const fftSizeRef = useRef(DEFAULT_SPECTRUM_FFT_SIZE)
  const displayModeRef = useRef<SpectrumDisplayMode>(DEFAULT_SPECTRUM_DISPLAY_MODE)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const tiltDbPerOctaveRef = useRef(DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE)
  const heatmapRef = useRef(false)
  const heatmapTiltDbPerOctaveRef = useRef(DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE)
  const scaleModeRef = useRef<FrequencyScaleMode>('log')
  const rangeModeRef = useRef<FrequencyRangeMode>('audible')
  const smoothingRef = useRef(DEFAULT_SPECTRUM_SMOOTHING)
  const heatmapSmoothingRef = useRef(DEFAULT_SPECTRUM_HEATMAP_SMOOTHING)
  const barDensityRef = useRef(DEFAULT_SPECTRUM_BAR_DENSITY)
  const barGapPercentRef = useRef(DEFAULT_SPECTRUM_BAR_GAP_PERCENT)
  const barCornerRadiusPxRef = useRef(DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX)
  const showBarPeaksRef = useRef(DEFAULT_SPECTRUM_SHOW_BAR_PEAKS)
  const heatColorsRef = useRef<[string, string, string]>([...CLASSIC_SPECTRUM_HEAT_COLORS])
  const isPlayingRef = useRef(false)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'spectrum') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      const nextFftSize = Math.max(1024, chunk.fftSize)
      const nextDisplayMode = isSpectrumDisplayMode(chunk.spectrumDisplayMode)
        ? chunk.spectrumDisplayMode
        : DEFAULT_SPECTRUM_DISPLAY_MODE
      const nextLineColor = chunk.lineColor
      const nextTiltDbPerOctave = chunk.spectrumTiltDbPerOctave
      const nextHeatmap = Boolean(chunk.spectrumHeatmap)
      const nextHeatmapTiltDbPerOctave = chunk.spectrumHeatmapTiltDbPerOctave
      const nextScaleMode = normalizeFrequencyScaleMode(chunk.spectrumScaleMode)
      const nextRangeMode = normalizeFrequencyRangeMode(chunk.spectrumRangeMode)
      const nextSmoothing = chunk.spectrumSmoothing
      const nextHeatmapSmoothing = chunk.spectrumHeatmapSmoothing
      const nextBarDensity = chunk.spectrumBarDensity
      const nextBarGapPercent = chunk.spectrumBarGapPercent
      const nextBarCornerRadiusPx = chunk.spectrumBarCornerRadiusPx
      const nextShowBarPeaks = Boolean(chunk.spectrumShowBarPeaks)
      const nextHeatColors = chunk.spectrumHeatColors
      const optionsChanged =
        nextScaleMode !== scaleModeRef.current ||
        nextRangeMode !== rangeModeRef.current ||
        nextFftSize !== fftSizeRef.current ||
        nextDisplayMode !== displayModeRef.current ||
        nextLineColor !== lineColorRef.current ||
        nextTiltDbPerOctave !== tiltDbPerOctaveRef.current ||
        nextHeatmap !== heatmapRef.current ||
        nextHeatmapTiltDbPerOctave !== heatmapTiltDbPerOctaveRef.current ||
        nextSmoothing !== smoothingRef.current ||
        nextHeatmapSmoothing !== heatmapSmoothingRef.current ||
        nextBarDensity !== barDensityRef.current ||
        nextBarGapPercent !== barGapPercentRef.current ||
        nextBarCornerRadiusPx !== barCornerRadiusPxRef.current ||
        nextShowBarPeaks !== showBarPeaksRef.current ||
        nextHeatColors.some((color, index) => color !== heatColorsRef.current[index])

      fftSizeRef.current = nextFftSize
      displayModeRef.current = nextDisplayMode
      lineColorRef.current = nextLineColor
      tiltDbPerOctaveRef.current = nextTiltDbPerOctave
      heatmapRef.current = nextHeatmap
      heatmapTiltDbPerOctaveRef.current = nextHeatmapTiltDbPerOctave
      scaleModeRef.current = nextScaleMode
      rangeModeRef.current = nextRangeMode
      smoothingRef.current = nextSmoothing
      heatmapSmoothingRef.current = nextHeatmapSmoothing
      barDensityRef.current = nextBarDensity
      barGapPercentRef.current = nextBarGapPercent
      barCornerRadiusPxRef.current = nextBarCornerRadiusPx
      showBarPeaksRef.current = nextShowBarPeaks
      heatColorsRef.current = nextHeatColors

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
        visualizerRef.current?.invalidate()
      } else if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
        isPlayingRef.current = true
        visualizerRef.current?.invalidate()
      }

      if (optionsChanged) {
        visualizerRef.current?.setOptions({
          lineColor: nextLineColor,
          fftSize: nextFftSize,
          displayMode: nextDisplayMode,
          fillGradient: !nextHeatmap,
          heatmapFill: nextHeatmap,
          tiltDbPerOctave: nextTiltDbPerOctave,
          heatmapTiltDbPerOctave: nextHeatmapTiltDbPerOctave,
          scaleType: nextScaleMode,
          ...nominalFrequencyBoundsForRange(nextRangeMode),
          smoothing: nextSmoothing,
          heatmapSmoothing: nextHeatmapSmoothing,
          barDensity: nextBarDensity,
          barGapPercent: nextBarGapPercent,
          barCornerRadiusPx: nextBarCornerRadiusPx,
          showBarPeaks: nextShowBarPeaks,
          heatColors: nextHeatColors,
          gradientColors: getSpectrumGradientColors(nextLineColor),
        })
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new SpectrumAnalyzer(canvasRef.current, {
        lineColor: lineColorRef.current,
        lineWidth: 2,
        fillGradient: !heatmapRef.current,
        heatmapFill: heatmapRef.current,
        tiltDbPerOctave: tiltDbPerOctaveRef.current,
        heatmapTiltDbPerOctave: heatmapTiltDbPerOctaveRef.current,
        smoothing: smoothingRef.current,
        heatmapSmoothing: heatmapSmoothingRef.current,
        barDensity: barDensityRef.current,
        barGapPercent: barGapPercentRef.current,
        barCornerRadiusPx: barCornerRadiusPxRef.current,
        showBarPeaks: showBarPeaksRef.current,
        heatColors: heatColorsRef.current,
        fftSize: fftSizeRef.current,
        displayMode: displayModeRef.current,
        gradientColors: getSpectrumGradientColors(lineColorRef.current),
        scaleType: scaleModeRef.current,
        ...nominalFrequencyBoundsForRange(rangeModeRef.current),
        showGrid: true,
        dataSource: {
          getPendingSpectrumSamples: () => {
            const pendingChunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return pendingChunks
          },
          // Popout streams mono chunks over IPC; mid/side stereo isn't relayed.
          getPendingSpectrumStereoSamples: () => [],
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
          subscribeToSessionChanges: () => () => {},
        },
      })
    }

    visualizerRef.current?.start()
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function OscilloscopeScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Oscilloscope | null>(null)
  const pendingRef = useRef(createMonoSampleQueue())
  const sampleRateRef = useRef(48000)
  const isPlayingRef = useRef(false)
  const resetListenersRef = useRef(new Set<() => void>())
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()
    if (!canvasRef.current) return
    const visualizer = new Oscilloscope(canvasRef.current, {
      lineColor: DEFAULT_SPECTRUM_LINE_COLOR,
      dataSource: {
        getPendingOscilloscopeSamples: () => pendingRef.current.drain(),
        getSampleRate: () => sampleRateRef.current,
        isPlaying: () => isPlayingRef.current,
        subscribeToSessionChanges: (listener) => {
          resetListenersRef.current.add(listener)
          return () => { resetListenersRef.current.delete(listener) }
        },
      },
    })
    visualizerRef.current = visualizer
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'oscilloscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      visualizer.setOptions({ lineColor: chunk.lineColor, pitchLock: chunk.pitchLock, underfillEnabled: chunk.oscilloscopeUnderfillEnabled })
      if (chunk.reset) {
        pendingRef.current.clear()
        isPlayingRef.current = false
        for (const reset of resetListenersRef.current) reset()
      } else if (chunk.leftChunks.length > 0) {
        for (const samples of chunk.leftChunks) pendingRef.current.push(samples, sampleRateRef.current * 0.25)
        isPlayingRef.current = true
      }
      visualizer.invalidate()
    })
    visualizer.start()
    visualizer.resize()
    return () => {
      unsubscribe()
      visualizer.dispose()
      visualizerRef.current = null
      pendingRef.current.clear()
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function VectorscopeScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Vectorscope | null>(null)
  const pendingRef = useRef(createStereoSampleQueue())
  const sampleRateRef = useRef(48000)
  const isPlayingRef = useRef(false)
  const resetListenersRef = useRef(new Set<() => void>())
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    applyResizeNow()
    if (!canvasRef.current) return
    const visualizer = new Vectorscope(canvasRef.current, {
      lineColor: DEFAULT_SPECTRUM_LINE_COLOR,
      dataSource: {
        getPendingVectorscopeSamples: () => pendingRef.current.drain(),
        getSampleRate: () => sampleRateRef.current,
        isPlaying: () => isPlayingRef.current,
        subscribeToSessionChanges: (listener) => {
          resetListenersRef.current.add(listener)
          return () => { resetListenersRef.current.delete(listener) }
        },
      },
    })
    visualizerRef.current = visualizer
    let previousOptions: Parameters<Vectorscope['setOptions']>[0] = {}
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'vectorscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      const nextOptions: Parameters<Vectorscope['setOptions']>[0] = {
        lineColor: chunk.lineColor,
        mode: isVectorscopeMode(chunk.vectorscopeMode) ? chunk.vectorscopeMode : 'lissajous',
        multiband: chunk.vectorscopeMultiband,
        zoomDb: normalizeVectorscopeZoomDb(chunk.vectorscopeZoomDb),
        phaseRiskColor: chunk.vectorscopePhaseRiskColor,
      }
      if (nextOptions.lineColor !== previousOptions.lineColor || nextOptions.mode !== previousOptions.mode
        || nextOptions.multiband !== previousOptions.multiband || nextOptions.zoomDb !== previousOptions.zoomDb
        || nextOptions.phaseRiskColor !== previousOptions.phaseRiskColor) {
        visualizer.setOptions(nextOptions)
        previousOptions = nextOptions
      }
      if (chunk.reset) {
        pendingRef.current.clear()
        isPlayingRef.current = false
        for (const reset of resetListenersRef.current) reset()
      } else if (chunk.stereoChunks.length > 0) {
        for (const samples of chunk.stereoChunks) pendingRef.current.push(samples, sampleRateRef.current * 0.25)
        isPlayingRef.current = true
      }
      visualizer.invalidate()
    })
    visualizer.start()
    visualizer.resize()
    return () => {
      unsubscribe()
      visualizer.dispose()
      visualizerRef.current = null
      pendingRef.current.clear()
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function SpectrogramScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Spectrogram | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const fftSizeRef = useRef(DEFAULT_SPECTRUM_FFT_SIZE)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const scrollSpeedRef = useRef(DEFAULT_SPECTROGRAM_SCROLL_SPEED)
  const clarityModeRef = useRef(DEFAULT_SPECTROGRAM_CLARITY_MODE)
  const rangeModeRef = useRef<FrequencyRangeMode>('audible')
  const scaleModeRef = useRef(DEFAULT_SPECTROGRAM_SCALE_MODE)
  const tiltDbPerOctaveRef = useRef(DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE)
  const contrastRef = useRef(DEFAULT_SPECTROGRAM_CONTRAST)
  const orientationRef = useRef(DEFAULT_SPECTROGRAM_ORIENTATION)
  const isPlayingRef = useRef(false)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'spectrogram') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      const nextFftSize = Math.max(1024, chunk.fftSize)
      const nextLineColor = chunk.lineColor
      const nextScrollSpeed = clampSpectrogramScrollSpeed(chunk.spectrogramScrollSpeed)
      const nextClarityMode = isSpectrogramClarityMode(chunk.spectrogramClarityMode)
        ? chunk.spectrogramClarityMode
        : DEFAULT_SPECTROGRAM_CLARITY_MODE
      const nextRangeMode = normalizeFrequencyRangeMode(chunk.spectrogramRangeMode)
      const nextScaleMode = isSpectrogramScaleMode(chunk.spectrogramScaleMode)
        ? chunk.spectrogramScaleMode
        : DEFAULT_SPECTROGRAM_SCALE_MODE
      const nextTiltDbPerOctave = clampSpectrogramTiltDbPerOctave(chunk.spectrogramTiltDbPerOctave)
      const nextContrast = clampSpectrogramContrast(chunk.spectrogramContrast)
      const nextOrientation = isSpectrogramOrientation(chunk.spectrogramOrientation)
        ? chunk.spectrogramOrientation
        : DEFAULT_SPECTROGRAM_ORIENTATION

      fftSizeRef.current = nextFftSize
      lineColorRef.current = nextLineColor
      scrollSpeedRef.current = nextScrollSpeed
      clarityModeRef.current = nextClarityMode
      rangeModeRef.current = nextRangeMode
      scaleModeRef.current = nextScaleMode
      tiltDbPerOctaveRef.current = nextTiltDbPerOctave
      contrastRef.current = nextContrast
      orientationRef.current = nextOrientation

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
        visualizerRef.current?.invalidate()
      } else if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
        isPlayingRef.current = true
        visualizerRef.current?.invalidate()
      }

      visualizerRef.current?.setOptions({
        fftSize: nextFftSize,
        lineColor: nextLineColor,
        scrollSpeed: nextScrollSpeed,
        clarityMode: nextClarityMode,
        scaleMode: nextScaleMode,
        ...nominalFrequencyBoundsForRange(nextRangeMode),
        tiltDbPerOctave: nextTiltDbPerOctave,
        contrast: nextContrast,
        orientation: nextOrientation,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Spectrogram(canvasRef.current, {
        fftSize: fftSizeRef.current,
        lineColor: lineColorRef.current,
        scrollSpeed: scrollSpeedRef.current,
        clarityMode: clarityModeRef.current,
        scaleMode: scaleModeRef.current,
        ...nominalFrequencyBoundsForRange(rangeModeRef.current),
        tiltDbPerOctave: tiltDbPerOctaveRef.current,
        contrast: contrastRef.current,
        orientation: orientationRef.current,
        colorScheme: 'heat',
        dataSource: {
          getPendingSpectrogramSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return chunks
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
          subscribeToSessionChanges: () => () => {},
        },
      })
    }

    visualizerRef.current?.start()
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function VUMeterScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<VUMeter | null>(null)

  const pendingChunksRef = useRef<MultichannelAudioChunk[]>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const vuMeterModeRef = useRef<VUMeterMode>(DEFAULT_VU_METER_MODE)
  const vuMeterOrientationRef = useRef<VUMeterOrientation>(DEFAULT_VU_METER_ORIENTATION)
  const isPlayingRef = useRef(false)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'vumeter') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor

      if ('vuMeterMode' in chunk && isVUMeterMode(chunk.vuMeterMode)) {
        vuMeterModeRef.current = chunk.vuMeterMode
      }
      if ('vuMeterOrientation' in chunk && isVUMeterOrientation(chunk.vuMeterOrientation)) {
        vuMeterOrientationRef.current = chunk.vuMeterOrientation
      }

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
        visualizerRef.current?.invalidate()
      } else if (chunk.channelChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.channelChunks)
        isPlayingRef.current = true
        visualizerRef.current?.invalidate()
      }

      visualizerRef.current?.setOptions({
        lineColor: chunk.lineColor,
        needleLeftColor: chunk.lineColor,
        needleRightColor: chunk.lineColor,
        needleCombinedColor: chunk.lineColor,
        mode: vuMeterModeRef.current,
        orientation: vuMeterOrientationRef.current,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new VUMeter(canvasRef.current, {
        lineColor: lineColorRef.current,
        needleLeftColor: lineColorRef.current,
        needleRightColor: lineColorRef.current,
        needleCombinedColor: lineColorRef.current,
        mode: vuMeterModeRef.current,
        orientation: vuMeterOrientationRef.current,
        dataSource: {
          getPendingVUMeterSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            // Relayed chunks are multichannel; the ported VU meter is stereo (L/R).
            return chunks.map((chunk) => {
              const left = chunk.channels[0] ?? new Float32Array(0)
              return { left, right: chunk.channels[1] ?? left }
            })
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
          subscribeToSessionChanges: () => () => {},
        },
      })
    }

    visualizerRef.current?.start()
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function LUFSMeterScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<LUFSMeter | null>(null)

  const pendingChunksRef = useRef<Array<{ left: Float32Array; right: Float32Array }>>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const isPlayingRef = useRef(false)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'lufsmeter') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
        visualizerRef.current?.invalidate()
      } else if (chunk.stereoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.stereoChunks)
        isPlayingRef.current = true
        visualizerRef.current?.invalidate()
      }

      visualizerRef.current?.setOptions({
        lineColor: chunk.lineColor,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new LUFSMeter(canvasRef.current, {
        lineColor: lineColorRef.current,
        dataSource: {
          getPendingLUFSMeterSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return chunks
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
          subscribeToSessionChanges: () => () => {},
        },
      })
    }

    visualizerRef.current?.start()
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function WaveformScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Waveform | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const scrollSpeedRef = useRef(DEFAULT_WAVEFORM_SCROLL_SPEED)
  const gainDbRef = useRef(DEFAULT_WAVEFORM_GAIN_DB)
  const multibandRef = useRef(false)
  const isPlayingRef = useRef(false)
  const { applyResizeNow } = useBufferedCanvasResize(containerRef, canvasRef, {
    onResize: () => visualizerRef.current?.resize(),
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'waveform') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor
      scrollSpeedRef.current = clampWaveformScrollSpeed(chunk.waveformScrollSpeed)
      gainDbRef.current = clampWaveformGainDb(chunk.waveformGainDb)
      multibandRef.current = Boolean(chunk.waveformMultiband)

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
        visualizerRef.current?.invalidate()
      } else if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
        isPlayingRef.current = true
        visualizerRef.current?.invalidate()
      }

      visualizerRef.current?.setOptions({
        lineColor: chunk.lineColor,
        scrollSpeed: scrollSpeedRef.current,
        multiband: multibandRef.current,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    applyResizeNow()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Waveform(canvasRef.current, {
        lineColor: lineColorRef.current,
        scrollSpeed: scrollSpeedRef.current,
        multiband: multibandRef.current,
        dataSource: {
          getPendingWaveformSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return chunks
          },
          // Popout relays mono chunks only; stereo/multiband waveform isn't streamed.
          getPendingWaveformStereoSamples: () => [],
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
          subscribeToSessionChanges: () => () => {},
        },
      })
    }

    visualizerRef.current?.start()
    visualizerRef.current?.resize()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [applyResizeNow])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function ScopeCanvas({ scope }: { scope: ScopeKind }) {
  switch (scope) {
    case 'spectrum':
      return <SpectrumScopeCanvas />
    case 'oscilloscope':
      return <OscilloscopeScopeCanvas />
    case 'vectorscope':
      return <VectorscopeScopeCanvas />
    case 'spectrogram':
      return <SpectrogramScopeCanvas />
    case 'vumeter':
      return <VUMeterScopeCanvas />
    case 'lufsmeter':
      return <LUFSMeterScopeCanvas />
    case 'waveform':
      return <WaveformScopeCanvas />
  }
}

function getScopeFromQuery(): ScopeKind | null {
  const rawScope = new URLSearchParams(window.location.search).get('scope')
  return isScopeKind(rawScope) ? rawScope : null
}

export default function ScopePopoutApp() {
  const scope = useMemo(() => getScopeFromQuery(), [])

  if (!scope) {
    return (
      <div className="scope-popout-root">
        <div className="scope-popout-invalid">
          <div className="scope-popout-invalid-title">Invalid scope target</div>
          <div className="scope-popout-invalid-hint">Open popouts from the analyzer deck buttons.</div>
        </div>
      </div>
    )
  }

  const label = getScopeLabel(scope)
  const handleRecall = () => {
    void window.electronAPI.scopePopout.recall(scope)
  }

  return (
    <div className="scope-popout-root">
      <header className="scope-popout-header">
        <div className="scope-popout-drag">
          <span className="scope-popout-badge">ASTRA</span>
          <span className="scope-popout-title">{label.toUpperCase()}</span>
        </div>
        <div className="scope-popout-controls">
          <button
            className="scope-popout-btn"
            onClick={handleRecall}
            title="Dock back in Astra"
            aria-label="Dock back in Astra"
          >
            Dock
          </button>
        </div>
      </header>
      <main className="scope-popout-body">
        <ScopeCanvas scope={scope} />
      </main>
    </div>
  )
}
