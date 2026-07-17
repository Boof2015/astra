import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { ScopeKind } from '../../../types/scopePopout'
import {
  MAX_SPECTROGRAM_SCROLL_SPEED,
  MIN_SPECTROGRAM_SCROLL_SPEED,
  SPECTROGRAM_SCROLL_SPEED_STEP,
  DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  MAX_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  MIN_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  SPECTROGRAM_TILT_STEP,
  DEFAULT_SPECTROGRAM_CONTRAST,
  MAX_SPECTROGRAM_CONTRAST,
  MIN_SPECTROGRAM_CONTRAST,
  SPECTROGRAM_CONTRAST_STEP,
  type SpectrogramClarityMode,
  type SpectrogramScaleMode,
  type SpectrogramOrientation,
} from '../../../types/spectrogram'
import type { VUMeterMode, VUMeterOrientation } from '../../../types/vumeter'
import {
  DEFAULT_WAVEFORM_GAIN_DB,
  MAX_WAVEFORM_GAIN_DB,
  MIN_WAVEFORM_GAIN_DB,
  MAX_WAVEFORM_SCROLL_SPEED,
  MIN_WAVEFORM_SCROLL_SPEED,
  WAVEFORM_GAIN_DB_STEP,
  WAVEFORM_SCROLL_SPEED_STEP,
  type WaveformMode,
} from '../../../types/waveform'
import {
  DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  MAX_SPECTRUM_TILT_DB_PER_OCTAVE,
  MIN_SPECTRUM_TILT_DB_PER_OCTAVE,
  SPECTRUM_TILT_STEP,
  DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  MAX_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  MIN_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  SPECTRUM_HEATMAP_TILT_STEP,
  DEFAULT_SPECTRUM_BAR_DENSITY,
  MIN_SPECTRUM_BAR_DENSITY,
  MAX_SPECTRUM_BAR_DENSITY,
  DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
  MIN_SPECTRUM_BAR_GAP_PERCENT,
  MAX_SPECTRUM_BAR_GAP_PERCENT,
  DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
  MIN_SPECTRUM_BAR_CORNER_RADIUS_PX,
  MAX_SPECTRUM_BAR_CORNER_RADIUS_PX,
  type SpectrumDisplayMode,
  type SpectrumHeatPalette,
} from '../../../types/spectrum'
import {
  useVisualizerSettingsStore,
  DEFAULT_SPECTRUM_SMOOTHING,
  DEFAULT_SPECTRUM_HEATMAP_SMOOTHING,
  MIN_SPECTRUM_SMOOTHING,
  MAX_SPECTRUM_SMOOTHING,
  SPECTRUM_SMOOTHING_STEP,
  type AnalyzerProfile,
  type FFTSize,
  type VectorscopeMode,
} from '../../stores/visualizerSettingsStore'
import { useUIStore } from '../../stores/uiStore'

const FFT_OPTIONS: readonly FFTSize[] = [1024, 2048, 4096, 8192, 16384]
const ACTIVE_SCOPE_EDGE_ALIGN_MIN_WIDTH = 560
type ActiveScopeAlignment = 'start' | 'center' | 'end'

interface AnalyzerEditOverlayProps {
  visibleScopes: ScopeKind[]
  hiddenScopes: ScopeKind[]
  gridTemplateColumns: string
  activeScope: ScopeKind | null
  isScopePinned: boolean
  draggedScope: ScopeKind | null
  isDraggingFromHidden: boolean
  isHiddenDropActive: boolean
  onHiddenScopeDragStart: (scope: ScopeKind, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onHiddenDragOver: (event: DragEvent<HTMLDivElement>) => void
  onHiddenDrop: (event: DragEvent<HTMLDivElement>) => void
  onScopeHoverChange: (scope: ScopeKind | null) => void
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

function vuMeterModeLabel(mode: VUMeterMode): string {
  switch (mode) {
    case 'needle': return 'Needle'
    case 'bar': return 'Bar'
  }
}

function vuMeterOrientationLabel(orientation: VUMeterOrientation): string {
  switch (orientation) {
    case 'horizontal': return 'Horizontal'
    case 'vertical': return 'Vertical'
  }
}

function vuMeterStateLabel(mode: VUMeterMode, orientation: VUMeterOrientation): string {
  if (mode === 'needle') return vuMeterModeLabel(mode)
  return `${vuMeterModeLabel(mode)} · ${vuMeterOrientationLabel(orientation)}`
}

function vectorscopeModeLabel(mode: VectorscopeMode): string {
  switch (mode) {
    case 'lissajous': return 'Lissajous'
    case 'polar-unipolar': return 'Polar (Uni)'
    case 'polar-bipolar': return 'Polar (Bi)'
    case 'linear-unipolar': return 'Linear (Uni)'
    case 'linear-bipolar': return 'Linear (Bi)'
  }
}

function spectrogramClarityLabel(mode: SpectrogramClarityMode): string {
  switch (mode) {
    case 'classic': return 'Classic'
    case 'sharp': return 'Sharp'
    case 'sharper': return 'Sharper'
  }
}

function spectrogramScaleLabel(mode: SpectrogramScaleMode): string {
  switch (mode) {
    case 'mel': return 'Mel'
    case 'log': return 'Log'
    case 'linear': return 'Linear'
  }
}

function spectrumDisplayModeLabel(mode: SpectrumDisplayMode): string {
  return mode === 'bars' ? 'BARS' : 'CURVE'
}

function scopeStateLabel(
  scope: ScopeKind,
  spectrumFftSize: FFTSize,
  spectrumDisplayMode: SpectrumDisplayMode,
  spectrogramFftSize: FFTSize,
  spectrogramScrollSpeed: number,
  waveformScrollSpeed: number,
  waveformMultiband: boolean,
  waveformMode: WaveformMode,
  spectrogramClarityMode: SpectrogramClarityMode,
  spectrogramScaleMode: SpectrogramScaleMode,
  pitchLock: boolean,
  underfillEnabled: boolean,
  vectorscopeMode: VectorscopeMode,
  vuMeterMode: VUMeterMode,
  vuMeterOrientation: VUMeterOrientation
): string {
  switch (scope) {
    case 'spectrum':
      return `${spectrumDisplayModeLabel(spectrumDisplayMode)} · FFT ${spectrumFftSize}`
    case 'oscilloscope':
      return pitchLock
        ? underfillEnabled ? 'Pitch-lock + underfill' : 'Pitch-lock'
        : underfillEnabled ? 'Free-run + underfill' : 'Free-run'
    case 'vectorscope':
      return vectorscopeModeLabel(vectorscopeMode)
    case 'spectrogram':
      return `${spectrogramScaleLabel(spectrogramScaleMode)} · ${spectrogramClarityLabel(spectrogramClarityMode)} x${spectrogramScrollSpeed.toFixed(1)} · FFT ${spectrogramFftSize}`
    case 'vumeter':
      return vuMeterStateLabel(vuMeterMode, vuMeterOrientation)
    case 'lufsmeter':
      return 'LUFS'
    case 'waveform': {
      const modeLabel = waveformMode === 'stereo' ? 'Stereo' : 'Mono'
      const rgbLabel = waveformMultiband ? 'RGB · ' : ''
      return `${modeLabel} · ${rgbLabel}Speed x${waveformScrollSpeed.toFixed(1)}`
    }
  }
}

function sortProfiles(profiles: Record<string, AnalyzerProfile>) {
  return Object.values(profiles).sort((left, right) => left.name.localeCompare(right.name))
}

function hiddenScopeGridStyle(index: number): CSSProperties {
  return {
    transitionDelay: `${index * 18}ms`,
  }
}

function formatSignedDb(value: number): string {
  return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1)
}

function ScopeGhost({ scope }: { scope: ScopeKind }) {
  switch (scope) {
    case 'spectrum':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <path d="M10 65 L28 50 L42 56 L58 34 L74 42 L90 18 L106 28 L132 10" />
          <path d="M10 70 H134" className="muted" />
          <path d="M24 70 V44 M48 70 V30 M72 70 V25 M96 70 V16" className="muted" />
        </svg>
      )
    case 'oscilloscope':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <path d="M10 40 C22 40 24 18 36 18 S50 62 62 62 S76 24 88 24 S102 56 114 56 S126 40 134 40" />
          <path d="M10 40 H134" className="muted" />
        </svg>
      )
    case 'vectorscope':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <circle cx="72" cy="40" r="26" />
          <path d="M72 14 V66 M46 40 H98" className="muted" />
          <path d="M54 58 L90 22" />
        </svg>
      )
    case 'spectrogram':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <rect x="10" y="10" width="124" height="60" rx="2" className="muted" />
          <rect x="14" y="50" width="8" height="16" opacity="0.3" />
          <rect x="26" y="40" width="8" height="26" opacity="0.4" />
          <rect x="38" y="30" width="8" height="36" opacity="0.5" />
          <rect x="50" y="20" width="8" height="46" opacity="0.6" />
          <rect x="62" y="35" width="8" height="31" opacity="0.7" />
          <rect x="74" y="25" width="8" height="41" opacity="0.8" />
          <rect x="86" y="15" width="8" height="51" opacity="0.9" />
          <rect x="98" y="30" width="8" height="36" opacity="0.7" />
          <rect x="110" y="40" width="8" height="26" opacity="0.5" />
          <rect x="122" y="45" width="8" height="21" opacity="0.4" />
        </svg>
      )
    case 'vumeter':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <rect x="22" y="20" width="70" height="8" rx="1" className="muted" />
          <rect x="22" y="20" width="48" height="8" rx="1" opacity="0.7" />
          <rect x="22" y="36" width="70" height="8" rx="1" className="muted" />
          <rect x="22" y="36" width="38" height="8" rx="1" opacity="0.6" />
          <text x="14" y="27" fontSize="8" opacity="0.5">L</text>
          <text x="14" y="43" fontSize="8" opacity="0.5">R</text>
          <rect x="22" y="56" width="70" height="5" rx="1" className="muted" />
          <rect x="57" y="56" width="20" height="5" rx="1" opacity="0.5" />
          <line x1="57" y1="54" x2="57" y2="63" className="muted" />
        </svg>
      )
    case 'lufsmeter':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <rect x="24" y="14" width="16" height="52" rx="1" className="muted" />
          <rect x="24" y="30" width="16" height="36" rx="1" opacity="0.7" />
          <rect x="54" y="14" width="16" height="52" rx="1" className="muted" />
          <rect x="54" y="38" width="16" height="28" rx="1" opacity="0.6" />
          <rect x="84" y="14" width="16" height="52" rx="1" className="muted" />
          <rect x="84" y="42" width="16" height="24" rx="1" opacity="0.5" />
          <text x="29" y="76" fontSize="8" textAnchor="middle" opacity="0.5">M</text>
          <text x="59" y="76" fontSize="8" textAnchor="middle" opacity="0.5">S</text>
          <text x="89" y="76" fontSize="8" textAnchor="middle" opacity="0.5">I</text>
          <line x1="20" y1="34" x2="104" y2="34" className="muted" strokeDasharray="3 2" />
        </svg>
      )
    case 'waveform':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <path d="M10 40 H134" className="muted" />
          <line x1="18" y1="34" x2="18" y2="46" opacity="0.3" />
          <line x1="28" y1="28" x2="28" y2="52" opacity="0.4" />
          <line x1="38" y1="22" x2="38" y2="58" opacity="0.5" />
          <line x1="48" y1="18" x2="48" y2="62" opacity="0.6" />
          <line x1="58" y1="24" x2="58" y2="56" opacity="0.7" />
          <line x1="68" y1="14" x2="68" y2="66" opacity="0.8" />
          <line x1="78" y1="20" x2="78" y2="60" opacity="0.9" />
          <line x1="88" y1="26" x2="88" y2="54" opacity="0.7" />
          <line x1="98" y1="30" x2="98" y2="50" opacity="0.5" />
          <line x1="108" y1="32" x2="108" y2="48" opacity="0.4" />
          <line x1="118" y1="28" x2="118" y2="52" opacity="0.6" />
          <line x1="128" y1="22" x2="128" y2="58" opacity="0.8" />
        </svg>
      )
  }
}

export default function AnalyzerEditOverlay({
  visibleScopes,
  hiddenScopes,
  gridTemplateColumns,
  activeScope,
  isScopePinned,
  draggedScope,
  isDraggingFromHidden,
  isHiddenDropActive,
  onHiddenScopeDragStart,
  onDragEnd,
  onHiddenDragOver,
  onHiddenDrop,
  onScopeHoverChange,
}: AnalyzerEditOverlayProps) {
  const profiles = useVisualizerSettingsStore((state) => state.profiles)
  const selectedProfileId = useVisualizerSettingsStore((state) => state.selectedProfileId)
  const selectedProfileName = useVisualizerSettingsStore((state) => state.selectedProfileName)
  const selectedProfileBuiltIn = useVisualizerSettingsStore((state) => state.selectedProfileBuiltIn)
  const selectedProfileCanDelete = useVisualizerSettingsStore((state) => state.selectedProfileCanDelete)
  const hasUnsavedProfileChanges = useVisualizerSettingsStore((state) => state.hasUnsavedProfileChanges)
  const fftSize = useVisualizerSettingsStore((state) => state.fftSize)
  const spectrogramFftSize = useVisualizerSettingsStore((state) => state.spectrogramFftSize)
  const spectrogramScrollSpeed = useVisualizerSettingsStore((state) => state.spectrogramScrollSpeed)
  const spectrogramClarityMode = useVisualizerSettingsStore((state) => state.spectrogramClarityMode)
  const spectrogramScaleMode = useVisualizerSettingsStore((state) => state.spectrogramScaleMode)
  const spectrogramTiltDbPerOctave = useVisualizerSettingsStore((state) => state.spectrogramTiltDbPerOctave)
  const spectrogramContrast = useVisualizerSettingsStore((state) => state.spectrogramContrast)
  const spectrogramOrientation = useVisualizerSettingsStore((state) => state.spectrogramOrientation)
  const spectrumHeatmap = useVisualizerSettingsStore((state) => state.spectrumHeatmap)
  const spectrumShowSideLine = useVisualizerSettingsStore((state) => state.spectrumShowSideLine)
  const setSpectrumShowSideLine = useVisualizerSettingsStore((state) => state.setSpectrumShowSideLine)
  const spectrumSmoothing = useVisualizerSettingsStore((state) => state.spectrumSmoothing)
  const spectrumHeatmapSmoothing = useVisualizerSettingsStore((state) => state.spectrumHeatmapSmoothing)
  const setSpectrumSmoothing = useVisualizerSettingsStore((state) => state.setSpectrumSmoothing)
  const setSpectrumHeatmapSmoothing = useVisualizerSettingsStore((state) => state.setSpectrumHeatmapSmoothing)
  const spectrumDisplayMode = useVisualizerSettingsStore((state) => state.spectrumDisplayMode)
  const spectrumTiltDbPerOctave = useVisualizerSettingsStore((state) => state.spectrumTiltDbPerOctave)
  const spectrumHeatmapTiltDbPerOctave = useVisualizerSettingsStore((state) => state.spectrumHeatmapTiltDbPerOctave)
  const setSpectrumDisplayMode = useVisualizerSettingsStore((state) => state.setSpectrumDisplayMode)
  const setSpectrumHeatmap = useVisualizerSettingsStore((state) => state.setSpectrumHeatmap)
  const setSpectrumTiltDbPerOctave = useVisualizerSettingsStore((state) => state.setSpectrumTiltDbPerOctave)
  const setSpectrumHeatmapTiltDbPerOctave = useVisualizerSettingsStore((state) => state.setSpectrumHeatmapTiltDbPerOctave)
  const spectrumBarDensity = useVisualizerSettingsStore((state) => state.spectrumBarDensity)
  const spectrumBarGapPercent = useVisualizerSettingsStore((state) => state.spectrumBarGapPercent)
  const spectrumBarCornerRadiusPx = useVisualizerSettingsStore((state) => state.spectrumBarCornerRadiusPx)
  const spectrumShowBarPeaks = useVisualizerSettingsStore((state) => state.spectrumShowBarPeaks)
  const spectrumHeatPalette = useVisualizerSettingsStore((state) => state.spectrumHeatPalette)
  const setSpectrumBarDensity = useVisualizerSettingsStore((state) => state.setSpectrumBarDensity)
  const setSpectrumBarGapPercent = useVisualizerSettingsStore((state) => state.setSpectrumBarGapPercent)
  const setSpectrumBarCornerRadiusPx = useVisualizerSettingsStore((state) => state.setSpectrumBarCornerRadiusPx)
  const setSpectrumShowBarPeaks = useVisualizerSettingsStore((state) => state.setSpectrumShowBarPeaks)
  const setSpectrumHeatPalette = useVisualizerSettingsStore((state) => state.setSpectrumHeatPalette)
  const waveformScrollSpeed = useVisualizerSettingsStore((state) => state.waveformScrollSpeed)
  const waveformGainDb = useVisualizerSettingsStore((state) => state.waveformGainDb)
  const waveformMultiband = useVisualizerSettingsStore((state) => state.waveformMultiband)
  const waveformMode = useVisualizerSettingsStore((state) => state.waveformMode)
  const setWaveformGainDb = useVisualizerSettingsStore((state) => state.setWaveformGainDb)
  const setWaveformMultiband = useVisualizerSettingsStore((state) => state.setWaveformMultiband)
  const setWaveformMode = useVisualizerSettingsStore((state) => state.setWaveformMode)
  const pitchLock = useVisualizerSettingsStore((state) => state.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((state) => state.oscilloscopeUnderfillEnabled)
  const setSelectedProfile = useVisualizerSettingsStore((state) => state.setSelectedProfile)
  const saveSelectedProfile = useVisualizerSettingsStore((state) => state.saveSelectedProfile)
  const saveCurrentProfileAs = useVisualizerSettingsStore((state) => state.saveCurrentProfileAs)
  const revertToSelectedProfile = useVisualizerSettingsStore((state) => state.revertToSelectedProfile)
  const deleteProfile = useVisualizerSettingsStore((state) => state.deleteProfile)
  const setFftSize = useVisualizerSettingsStore((state) => state.setFftSize)
  const setSpectrogramFftSize = useVisualizerSettingsStore((state) => state.setSpectrogramFftSize)
  const setSpectrogramScrollSpeed = useVisualizerSettingsStore((state) => state.setSpectrogramScrollSpeed)
  const setSpectrogramClarityMode = useVisualizerSettingsStore((state) => state.setSpectrogramClarityMode)
  const setSpectrogramScaleMode = useVisualizerSettingsStore((state) => state.setSpectrogramScaleMode)
  const setSpectrogramTiltDbPerOctave = useVisualizerSettingsStore((state) => state.setSpectrogramTiltDbPerOctave)
  const setSpectrogramContrast = useVisualizerSettingsStore((state) => state.setSpectrogramContrast)
  const setSpectrogramOrientation = useVisualizerSettingsStore((state) => state.setSpectrogramOrientation)
  const setWaveformScrollSpeed = useVisualizerSettingsStore((state) => state.setWaveformScrollSpeed)
  const setPitchLock = useVisualizerSettingsStore((state) => state.setPitchLock)
  const setOscilloscopeUnderfillEnabled = useVisualizerSettingsStore((state) => state.setOscilloscopeUnderfillEnabled)
  const vectorscopeMode = useVisualizerSettingsStore((state) => state.vectorscopeMode)
  const setVectorscopeMode = useVisualizerSettingsStore((state) => state.setVectorscopeMode)
  const vectorscopeMultiband = useVisualizerSettingsStore((state) => state.vectorscopeMultiband)
  const setVectorscopeMultiband = useVisualizerSettingsStore((state) => state.setVectorscopeMultiband)
  const vuMeterMode = useVisualizerSettingsStore((state) => state.vuMeterMode)
  const vuMeterOrientation = useVisualizerSettingsStore((state) => state.vuMeterOrientation)
  const setVUMeterMode = useVisualizerSettingsStore((state) => state.setVUMeterMode)
  const setVUMeterOrientation = useVisualizerSettingsStore((state) => state.setVUMeterOrientation)

  const closeAnalyzerEditMode = useUIStore((state) => state.closeAnalyzerEditMode)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const setPendingSettingsSection = useUIStore((state) => state.setPendingSettingsSection)

  const [showSaveAsInput, setShowSaveAsInput] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [saveAsError, setSaveAsError] = useState<string | null>(null)
  const [activeScopeAlignment, setActiveScopeAlignment] = useState<ActiveScopeAlignment>('center')
  const activeSlotRef = useRef<HTMLDivElement | null>(null)
  const activeStripRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setShowSaveAsInput(false)
    setSaveAsName('')
    setSaveAsError(null)
  }, [selectedProfileId])

  const sortedProfiles = useMemo(() => sortProfiles(profiles), [profiles])
  const builtInProfiles = useMemo(
    () => sortedProfiles.filter((profile) => profile.builtIn),
    [sortedProfiles]
  )
  const userProfiles = useMemo(
    () => sortedProfiles.filter((profile) => !profile.builtIn),
    [sortedProfiles]
  )
  const showHiddenDropField = draggedScope !== null && !isDraggingFromHidden
  const activeScopeIndex = activeScope ? visibleScopes.indexOf(activeScope) : -1

  useEffect(() => {
    if (activeScopeIndex === -1) {
      setActiveScopeAlignment('center')
      return
    }

    const measureAlignment = () => {
      const slot = activeSlotRef.current
      const strip = activeStripRef.current
      if (!slot || !strip) return

      const slotRect = slot.getBoundingClientRect()
      const stripRect = strip.getBoundingClientRect()
      const slotIsNarrow = slotRect.width < ACTIVE_SCOPE_EDGE_ALIGN_MIN_WIDTH
      const stripNeedsJustify = stripRect.width > slotRect.width + 1

      if (!slotIsNarrow && !stripNeedsJustify) {
        setActiveScopeAlignment((current) => current === 'center' ? current : 'center')
        return
      }

      const viewportWidth = window.innerWidth
      const slotCenter = slotRect.left + (slotRect.width / 2)
      let preferredAlignment: ActiveScopeAlignment = 'center'
      if (slotCenter <= viewportWidth * 0.34) {
        preferredAlignment = 'start'
      } else if (slotCenter >= viewportWidth * 0.66) {
        preferredAlignment = 'end'
      }

      if (preferredAlignment === 'center') {
        setActiveScopeAlignment((current) => current === 'center' ? current : 'center')
        return
      }

      const startFits = viewportWidth - slotRect.left >= stripRect.width
      const endFits = slotRect.right >= stripRect.width

      let nextAlignment = preferredAlignment
      if (preferredAlignment === 'start' && !startFits && endFits) {
        nextAlignment = 'end'
      } else if (preferredAlignment === 'end' && !endFits && startFits) {
        nextAlignment = 'start'
      }

      setActiveScopeAlignment((current) => current === nextAlignment ? current : nextAlignment)
    }

    const frameId = window.requestAnimationFrame(measureAlignment)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          measureAlignment()
        })

    if (resizeObserver) {
      if (activeSlotRef.current) resizeObserver.observe(activeSlotRef.current)
      if (activeStripRef.current) resizeObserver.observe(activeStripRef.current)
    }

    window.addEventListener('resize', measureAlignment)

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', measureAlignment)
    }
  }, [activeScopeIndex, activeScope, gridTemplateColumns, visibleScopes.length])

  const handleSaveAs = () => {
    const result = saveCurrentProfileAs(saveAsName)
    if (!result.ok) {
      setSaveAsError(result.error)
      return
    }
    setShowSaveAsInput(false)
    setSaveAsName('')
    setSaveAsError(null)
  }

  const openAnalyzerSettings = () => {
    closeAnalyzerEditMode()
    setActiveView('settings')
    setPendingSettingsSection('analyzer')
  }

  const renderActiveControls = (scope: ScopeKind) => {
    switch (scope) {
      case 'spectrum':
        return (
          <div className="analyzer-edit-active-controls analyzer-edit-active-controls-inline analyzer-edit-active-controls-spectrum">
            <div className="analyzer-edit-spectrum-control-grid analyzer-edit-spectrum-primary-grid">
              <div className="analyzer-edit-mini-control">
                <span className="analyzer-edit-corner-label">Display</span>
                <select
                  className="analyzer-edit-select"
                  value={spectrumDisplayMode}
                  onChange={(event) => setSpectrumDisplayMode(event.target.value as SpectrumDisplayMode)}
                >
                  <option value="curve">Curve</option>
                  <option value="bars">Bars</option>
                </select>
              </div>
              <div className="analyzer-edit-mini-control">
                <span className="analyzer-edit-corner-label">FFT</span>
                <select
                  className="analyzer-edit-select"
                  value={fftSize}
                  onChange={(event) => setFftSize(Number(event.target.value) as FFTSize)}
                >
                  {FFT_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className={`analyzer-edit-button ${spectrumHeatmap ? 'is-active' : ''}`.trim()}
                onClick={() => setSpectrumHeatmap(!spectrumHeatmap)}
              >
                Heat {spectrumHeatmap ? 'On' : 'Off'}
              </button>
              <button
                type="button"
                className={`analyzer-edit-button ${spectrumShowSideLine ? 'is-active' : ''} ${spectrumDisplayMode === 'bars' ? 'is-disabled' : ''}`.trim()}
                onClick={() => setSpectrumShowSideLine(!spectrumShowSideLine)}
                disabled={spectrumDisplayMode === 'bars'}
                title={spectrumDisplayMode === 'bars' ? 'Curve only' : undefined}
              >
                Side {spectrumDisplayMode === 'bars' ? 'Curve only' : spectrumShowSideLine ? 'On' : 'Off'}
              </button>
              {spectrumHeatmap ? (
                <div className="analyzer-edit-mini-control analyzer-edit-spectrum-palette-control">
                  <span className="analyzer-edit-corner-label">Heat Palette</span>
                  <select
                    className="analyzer-edit-select"
                    value={spectrumHeatPalette}
                    onChange={(event) => setSpectrumHeatPalette(event.target.value as SpectrumHeatPalette)}
                  >
                    <option value="classic">Classic</option>
                    <option value="accent">Accent</option>
                  </select>
                </div>
              ) : null}
            </div>
            {spectrumDisplayMode === 'bars' ? (
              <div className="analyzer-edit-spectrum-control-grid analyzer-edit-spectrum-bar-grid">
                <div
                  className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
                  onDoubleClick={() => setSpectrumBarDensity(DEFAULT_SPECTRUM_BAR_DENSITY)}
                  title={`Double-click to reset to ${DEFAULT_SPECTRUM_BAR_DENSITY}`}
                >
                  <span className="analyzer-edit-corner-label">Density {spectrumBarDensity}</span>
                  <input
                    type="range"
                    className="analyzer-edit-range"
                    min={MIN_SPECTRUM_BAR_DENSITY}
                    max={MAX_SPECTRUM_BAR_DENSITY}
                    step={1}
                    value={spectrumBarDensity}
                    aria-label="Spectrum bar density"
                    onChange={(event) => setSpectrumBarDensity(Number(event.target.value))}
                  />
                </div>
                <div
                  className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
                  onDoubleClick={() => setSpectrumBarGapPercent(DEFAULT_SPECTRUM_BAR_GAP_PERCENT)}
                  title={`Double-click to reset to ${DEFAULT_SPECTRUM_BAR_GAP_PERCENT}%`}
                >
                  <span className="analyzer-edit-corner-label">Gap {spectrumBarGapPercent}%</span>
                  <input
                    type="range"
                    className="analyzer-edit-range"
                    min={MIN_SPECTRUM_BAR_GAP_PERCENT}
                    max={MAX_SPECTRUM_BAR_GAP_PERCENT}
                    step={1}
                    value={spectrumBarGapPercent}
                    aria-label="Spectrum bar gap"
                    onChange={(event) => setSpectrumBarGapPercent(Number(event.target.value))}
                  />
                </div>
                <div
                  className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
                  onDoubleClick={() => setSpectrumBarCornerRadiusPx(DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX)}
                  title={`Double-click to reset to ${DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX}px`}
                >
                  <span className="analyzer-edit-corner-label">Radius {spectrumBarCornerRadiusPx}px</span>
                  <input
                    type="range"
                    className="analyzer-edit-range"
                    min={MIN_SPECTRUM_BAR_CORNER_RADIUS_PX}
                    max={MAX_SPECTRUM_BAR_CORNER_RADIUS_PX}
                    step={1}
                    value={spectrumBarCornerRadiusPx}
                    aria-label="Spectrum bar corner radius"
                    onChange={(event) => setSpectrumBarCornerRadiusPx(Number(event.target.value))}
                  />
                </div>
                <button
                  type="button"
                  className={`analyzer-edit-button ${spectrumShowBarPeaks ? 'is-active' : ''}`.trim()}
                  onClick={() => setSpectrumShowBarPeaks(!spectrumShowBarPeaks)}
                >
                  Peaks {spectrumShowBarPeaks ? 'On' : 'Off'}
                </button>
              </div>
            ) : null}
            <div className="analyzer-edit-spectrum-control-grid analyzer-edit-spectrum-response-grid">
              <div
                className="analyzer-edit-mini-control analyzer-edit-mini-control-range"
                onDoubleClick={() => setSpectrumTiltDbPerOctave(DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE)}
                title={`Double-click to reset to ${DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE.toFixed(1)} dB/oct`}
              >
                <span className="analyzer-edit-corner-label">
                  Tilt {spectrumTiltDbPerOctave.toFixed(1)} dB/oct
                </span>
                <input
                  type="range"
                  className="analyzer-edit-range"
                  min={MIN_SPECTRUM_TILT_DB_PER_OCTAVE}
                  max={MAX_SPECTRUM_TILT_DB_PER_OCTAVE}
                  step={SPECTRUM_TILT_STEP}
                  value={spectrumTiltDbPerOctave}
                  aria-label="Spectrum tilt"
                  onChange={(event) => setSpectrumTiltDbPerOctave(Number(event.target.value))}
                />
              </div>
              <div
                className={`analyzer-edit-mini-control analyzer-edit-mini-control-range ${spectrumHeatmap ? '' : 'is-disabled'}`.trim()}
                onDoubleClick={() => setSpectrumHeatmapTiltDbPerOctave(DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE)}
                title={`Double-click to reset to ${DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE.toFixed(1)} dB/oct`}
              >
                <span className="analyzer-edit-corner-label">
                  Heat Tilt {spectrumHeatmapTiltDbPerOctave.toFixed(1)} dB/oct
                </span>
                <input
                  type="range"
                  className="analyzer-edit-range"
                  min={MIN_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE}
                  max={MAX_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE}
                  step={SPECTRUM_HEATMAP_TILT_STEP}
                  value={spectrumHeatmapTiltDbPerOctave}
                  disabled={!spectrumHeatmap}
                  aria-label="Spectrum heatmap tilt"
                  onChange={(event) => setSpectrumHeatmapTiltDbPerOctave(Number(event.target.value))}
                />
              </div>
              <div
                className="analyzer-edit-mini-control analyzer-edit-mini-control-range"
                onDoubleClick={() => setSpectrumSmoothing(DEFAULT_SPECTRUM_SMOOTHING)}
                title={`Double-click to reset to ${DEFAULT_SPECTRUM_SMOOTHING.toFixed(2)}`}
              >
                <span className="analyzer-edit-corner-label">
                  Smoothing {spectrumSmoothing.toFixed(2)}
                </span>
                <input
                  type="range"
                  className="analyzer-edit-range"
                  min={MIN_SPECTRUM_SMOOTHING}
                  max={MAX_SPECTRUM_SMOOTHING}
                  step={SPECTRUM_SMOOTHING_STEP}
                  value={spectrumSmoothing}
                  aria-label="Spectrum smoothing"
                  onChange={(event) => setSpectrumSmoothing(Number(event.target.value))}
                />
              </div>
              <div
                className={`analyzer-edit-mini-control analyzer-edit-mini-control-range ${spectrumHeatmap ? '' : 'is-disabled'}`.trim()}
                onDoubleClick={() => setSpectrumHeatmapSmoothing(DEFAULT_SPECTRUM_HEATMAP_SMOOTHING)}
                title={`Double-click to reset to ${DEFAULT_SPECTRUM_HEATMAP_SMOOTHING.toFixed(2)}`}
              >
                <span className="analyzer-edit-corner-label">
                  Heat Smoothing {spectrumHeatmapSmoothing.toFixed(2)}
                </span>
                <input
                  type="range"
                  className="analyzer-edit-range"
                  min={MIN_SPECTRUM_SMOOTHING}
                  max={MAX_SPECTRUM_SMOOTHING}
                  step={SPECTRUM_SMOOTHING_STEP}
                  value={spectrumHeatmapSmoothing}
                  disabled={!spectrumHeatmap}
                  aria-label="Spectrum heatmap smoothing"
                  onChange={(event) => setSpectrumHeatmapSmoothing(Number(event.target.value))}
                />
              </div>
            </div>
          </div>
        )
      case 'oscilloscope':
        return (
          <div className="analyzer-edit-active-controls analyzer-edit-active-controls-inline">
            <button
              type="button"
              className={`analyzer-edit-button ${pitchLock ? 'is-active' : ''}`.trim()}
              onClick={() => setPitchLock(!pitchLock)}
            >
              Pitch {pitchLock ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              className={`analyzer-edit-button ${oscilloscopeUnderfillEnabled ? 'is-active' : ''}`.trim()}
              onClick={() => setOscilloscopeUnderfillEnabled(!oscilloscopeUnderfillEnabled)}
            >
              Fill {oscilloscopeUnderfillEnabled ? 'On' : 'Off'}
            </button>
          </div>
        )
      case 'vectorscope':
        return (
          <div className="analyzer-edit-active-controls analyzer-edit-active-controls-inline">
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">Scope</span>
              <select
                className="analyzer-edit-select"
                value={vectorscopeMode}
                onChange={(event) => setVectorscopeMode(event.target.value as VectorscopeMode)}
              >
                <option value="lissajous">Lissajous</option>
                <option value="polar-unipolar">Polar (Uni)</option>
                <option value="polar-bipolar">Polar (Bi)</option>
                <option value="linear-unipolar">Linear (Uni)</option>
                <option value="linear-bipolar">Linear (Bi)</option>
              </select>
            </div>
            <button
              type="button"
              className={`analyzer-edit-button ${vectorscopeMultiband ? 'is-active' : ''}`.trim()}
              onClick={() => setVectorscopeMultiband(!vectorscopeMultiband)}
            >
              RGB {vectorscopeMultiband ? 'On' : 'Off'}
            </button>
          </div>
        )
      case 'spectrogram':
        return (
          <div className="analyzer-edit-active-controls">
            <div className="analyzer-edit-spectrogram-selects">
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">FFT</span>
              <select
                className="analyzer-edit-select"
                value={spectrogramFftSize}
                onChange={(event) => setSpectrogramFftSize(Number(event.target.value) as FFTSize)}
              >
                {FFT_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">Scale</span>
              <select
                className="analyzer-edit-select"
                value={spectrogramScaleMode}
                onChange={(event) => setSpectrogramScaleMode(event.target.value as SpectrogramScaleMode)}
              >
                <option value="mel">Mel</option>
                <option value="log">Log</option>
                <option value="linear">Linear</option>
              </select>
            </div>
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">Mode</span>
              <select
                className="analyzer-edit-select"
                value={spectrogramClarityMode}
                onChange={(event) => setSpectrogramClarityMode(event.target.value as SpectrogramClarityMode)}
              >
                <option value="classic">Classic</option>
                <option value="sharp">Sharp</option>
                <option value="sharper">Sharper</option>
              </select>
            </div>
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">Orient</span>
              <select
                className="analyzer-edit-select"
                value={spectrogramOrientation}
                onChange={(event) => setSpectrogramOrientation(event.target.value as SpectrogramOrientation)}
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </div>
            </div>
            <div className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide">
              <span className="analyzer-edit-corner-label">Speed x{spectrogramScrollSpeed.toFixed(1)}</span>
              <input
                type="range"
                className="analyzer-edit-range"
                min={MIN_SPECTROGRAM_SCROLL_SPEED}
                max={MAX_SPECTROGRAM_SCROLL_SPEED}
                step={SPECTROGRAM_SCROLL_SPEED_STEP}
                value={spectrogramScrollSpeed}
                onChange={(event) => setSpectrogramScrollSpeed(Number(event.target.value))}
              />
            </div>
            <div
              className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
              onDoubleClick={() => setSpectrogramTiltDbPerOctave(DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE)}
              title={`Double-click to reset to ${DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE.toFixed(1)} dB/oct`}
            >
              <span className="analyzer-edit-corner-label">
                Tilt {spectrogramTiltDbPerOctave.toFixed(1)} dB/oct
              </span>
              <input
                type="range"
                className="analyzer-edit-range"
                min={MIN_SPECTROGRAM_TILT_DB_PER_OCTAVE}
                max={MAX_SPECTROGRAM_TILT_DB_PER_OCTAVE}
                step={SPECTROGRAM_TILT_STEP}
                value={spectrogramTiltDbPerOctave}
                aria-label="Spectrogram tilt"
                onChange={(event) => setSpectrogramTiltDbPerOctave(Number(event.target.value))}
              />
            </div>
            <div
              className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
              onDoubleClick={() => setSpectrogramContrast(DEFAULT_SPECTROGRAM_CONTRAST)}
              title={`Double-click to reset to ${DEFAULT_SPECTROGRAM_CONTRAST.toFixed(1)}`}
            >
              <span className="analyzer-edit-corner-label">
                Contrast {spectrogramContrast.toFixed(1)}
              </span>
              <input
                type="range"
                className="analyzer-edit-range"
                min={MIN_SPECTROGRAM_CONTRAST}
                max={MAX_SPECTROGRAM_CONTRAST}
                step={SPECTROGRAM_CONTRAST_STEP}
                value={spectrogramContrast}
                aria-label="Spectrogram contrast"
                onChange={(event) => setSpectrogramContrast(Number(event.target.value))}
              />
            </div>
          </div>
        )
      case 'vumeter':
        return (
          <div className="analyzer-edit-active-controls">
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">VU</span>
              <select
                className="analyzer-edit-select"
                value={vuMeterMode}
                onChange={(event) => setVUMeterMode(event.target.value as VUMeterMode)}
              >
                <option value="bar">Bar</option>
                <option value="needle">Needle</option>
              </select>
            </div>
            <div className="analyzer-edit-mini-control">
              <span className="analyzer-edit-corner-label">Orientation</span>
              <select
                className="analyzer-edit-select"
                value={vuMeterOrientation}
                disabled={vuMeterMode !== 'bar'}
                onChange={(event) => setVUMeterOrientation(event.target.value as VUMeterOrientation)}
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </div>
          </div>
        )
      case 'lufsmeter':
        return <div className="analyzer-edit-active-note">No extra controls here</div>
      case 'waveform':
        return (
          <div className="analyzer-edit-active-controls analyzer-edit-active-controls-waveform">
            <button
              type="button"
              className={`analyzer-edit-button ${waveformMode === 'stereo' ? 'is-active' : ''}`.trim()}
              onClick={() => setWaveformMode(waveformMode === 'stereo' ? 'mono' : 'stereo')}
            >
              {waveformMode === 'stereo' ? 'Stereo' : 'Mono'}
            </button>
            <button
              type="button"
              className={`analyzer-edit-button ${waveformMultiband ? 'is-active' : ''}`.trim()}
              onClick={() => setWaveformMultiband(!waveformMultiband)}
            >
              RGB {waveformMultiband ? 'On' : 'Off'}
            </button>
            <div
              className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide"
              onDoubleClick={() => setWaveformGainDb(DEFAULT_WAVEFORM_GAIN_DB)}
              title={`Double-click to reset to ${formatSignedDb(DEFAULT_WAVEFORM_GAIN_DB)} dB`}
            >
              <span className="analyzer-edit-corner-label">Gain {formatSignedDb(waveformGainDb)} dB</span>
              <input
                type="range"
                className="analyzer-edit-range"
                min={MIN_WAVEFORM_GAIN_DB}
                max={MAX_WAVEFORM_GAIN_DB}
                step={WAVEFORM_GAIN_DB_STEP}
                value={waveformGainDb}
                aria-label="Waveform gain"
                onChange={(event) => setWaveformGainDb(Number(event.target.value))}
              />
            </div>
            <div className="analyzer-edit-mini-control analyzer-edit-mini-control-range analyzer-edit-active-control-wide">
              <span className="analyzer-edit-corner-label">Speed x{waveformScrollSpeed.toFixed(1)}</span>
              <input
                type="range"
                className="analyzer-edit-range"
                min={MIN_WAVEFORM_SCROLL_SPEED}
                max={MAX_WAVEFORM_SCROLL_SPEED}
                step={WAVEFORM_SCROLL_SPEED_STEP}
                value={waveformScrollSpeed}
                onChange={(event) => setWaveformScrollSpeed(Number(event.target.value))}
              />
            </div>
          </div>
        )
    }
  }

  return (
    <div className="analyzer-edit-overlay-backdrop">
      {showHiddenDropField && (
        <div
          className={`analyzer-edit-stash-dropfield ${isHiddenDropActive ? 'is-active' : ''}`.trim()}
          onDragOver={onHiddenDragOver}
          onDrop={onHiddenDrop}
        >
          <div className="analyzer-edit-stash-dropfield-label">Drop here to stash the scope</div>
        </div>
      )}

      <div className="analyzer-edit-corner analyzer-edit-corner-top-left">
        <div className="analyzer-edit-profile-toolbar">
          <div className="analyzer-edit-profile-picker">
            <label className="analyzer-edit-corner-label analyzer-edit-corner-label-inline" htmlFor="analyzer-edit-profile-select">
              PROFILE
            </label>
            <select
              id="analyzer-edit-profile-select"
              className="analyzer-edit-select"
              value={selectedProfileId}
              onChange={(event) => {
                setSelectedProfile(event.target.value)
              }}
            >
              <optgroup label="Built-in">
                {builtInProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
              {userProfiles.length > 0 && (
                <optgroup label="My Profiles">
                  {userProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div className="analyzer-edit-profile-status" aria-label="Profile status">
            <div className="analyzer-edit-badge">
              {selectedProfileBuiltIn ? 'Built-in' : 'Saved'}
            </div>
            {hasUnsavedProfileChanges && (
              <div className="analyzer-edit-badge analyzer-edit-badge-accent">
                Edited
              </div>
            )}
          </div>

          {showSaveAsInput ? (
            <div className="analyzer-edit-save-inline">
              <input
                type="text"
                className="analyzer-edit-input"
                value={saveAsName}
                placeholder="New profile name..."
                onChange={(event) => {
                  setSaveAsName(event.target.value)
                  setSaveAsError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleSaveAs()
                  } else if (event.key === 'Escape') {
                    setShowSaveAsInput(false)
                    setSaveAsName('')
                    setSaveAsError(null)
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                className="analyzer-edit-button analyzer-edit-button-primary"
                disabled={saveAsName.trim().length === 0}
                onClick={handleSaveAs}
              >
                Create
              </button>
              <button
                type="button"
                className="analyzer-edit-button"
                onClick={() => {
                  setShowSaveAsInput(false)
                  setSaveAsName('')
                  setSaveAsError(null)
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="analyzer-edit-profile-actions">
              <button
                type="button"
                className="analyzer-edit-button"
                disabled={selectedProfileBuiltIn || !hasUnsavedProfileChanges}
                onClick={() => saveSelectedProfile()}
              >
                Save
              </button>
              <button
                type="button"
                className="analyzer-edit-button"
                onClick={() => {
                  setShowSaveAsInput(true)
                  setSaveAsName(selectedProfileBuiltIn ? '' : selectedProfileName)
                  setSaveAsError(null)
                }}
              >
                Save As
              </button>
              <button
                type="button"
                className="analyzer-edit-button"
                disabled={!hasUnsavedProfileChanges}
                onClick={() => revertToSelectedProfile()}
              >
                Revert
              </button>
              <button
                type="button"
                className="analyzer-edit-button"
                disabled={!selectedProfileCanDelete}
                onClick={() => deleteProfile(selectedProfileId)}
              >
                Delete
              </button>
            </div>
          )}

          {saveAsError && (
            <div
              className="analyzer-edit-inline-feedback is-error"
              role="alert"
              aria-live="polite"
            >
              {saveAsError}
            </div>
          )}
        </div>
      </div>

      <div className="analyzer-edit-corner analyzer-edit-corner-top-right">
        <button
          type="button"
          className="analyzer-edit-button"
          onClick={openAnalyzerSettings}
        >
          Settings
        </button>
        <button
          type="button"
          className="analyzer-edit-button analyzer-edit-button-primary"
          onClick={closeAnalyzerEditMode}
        >
          Done
        </button>
      </div>

      {activeScope && activeScopeIndex !== -1 && (
        <div
          className="analyzer-edit-active-track"
          style={gridTemplateColumns ? { gridTemplateColumns } : undefined}
        >
          <div
            className={`analyzer-edit-active-slot is-align-${activeScopeAlignment}`.trim()}
            ref={activeSlotRef}
            style={{ gridColumn: `${activeScopeIndex + 1}` }}
          >
            <div
              className={`analyzer-edit-active-strip ${activeScope === 'waveform' ? 'is-waveform-active' : ''} ${activeScope === 'spectrum' ? 'is-spectrum-active' : ''}`.trim()}
              ref={activeStripRef}
              onMouseEnter={() => onScopeHoverChange(activeScope)}
            >
              <div className="analyzer-edit-active-headline">
                <div className="analyzer-edit-active-title">{scopeLabel(activeScope).toUpperCase()}</div>
                <div className="analyzer-edit-active-meta">
                  {scopeStateLabel(
                    activeScope,
                    fftSize,
                    spectrumDisplayMode,
                    spectrogramFftSize,
                    spectrogramScrollSpeed,
                    waveformScrollSpeed,
                    waveformMultiband,
                    waveformMode,
                    spectrogramClarityMode,
                    spectrogramScaleMode,
                    pitchLock,
                    oscilloscopeUnderfillEnabled,
                    vectorscopeMode,
                    vuMeterMode,
                    vuMeterOrientation
                  )}
                </div>
                {isScopePinned && (
                  <div className="analyzer-edit-active-pin-note">Pinned</div>
                )}
              </div>
              {renderActiveControls(activeScope)}
            </div>
          </div>
        </div>
      )}

      <div className="analyzer-edit-corner analyzer-edit-corner-bottom-left">
        <div className="analyzer-edit-help">
          <div className="analyzer-edit-corner-label">EDIT MODE</div>
          <div className="analyzer-edit-help-copy">
            Hover a scope to edit it.
            <br />
            Click a scope to pin its controls.
            <br />
            Drag scopes to reorder, stash, or resize.
          </div>
        </div>
      </div>

      {hiddenScopes.length === 0 ? (
        <div className="analyzer-edit-empty-hint">
          Nothing is stashed right now.
        </div>
      ) : (
        <div className="analyzer-edit-stash-grid">
          {hiddenScopes.map((scope, index) => (
            <div
              key={scope}
              className={`analyzer-edit-stash-scope ${draggedScope === scope ? 'is-dragging' : ''}`.trim()}
              style={hiddenScopeGridStyle(index)}
              draggable
              onDragStart={(event) => onHiddenScopeDragStart(scope, event)}
              onDragEnd={onDragEnd}
            >
              <div className="analyzer-edit-stash-header">
                <span>{scopeLabel(scope).toUpperCase()}</span>
                <span>STASHED</span>
              </div>
              <div className="analyzer-edit-stash-preview">
                <ScopeGhost scope={scope} />
              </div>
              <div className="analyzer-edit-stash-meta">
                {scopeStateLabel(
                  scope,
                  fftSize,
                  spectrumDisplayMode,
                  spectrogramFftSize,
                  spectrogramScrollSpeed,
                  waveformScrollSpeed,
                  waveformMultiband,
                  waveformMode,
                  spectrogramClarityMode,
                  spectrogramScaleMode,
                  pitchLock,
                  oscilloscopeUnderfillEnabled,
                  vectorscopeMode,
                  vuMeterMode,
                  vuMeterOrientation
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
