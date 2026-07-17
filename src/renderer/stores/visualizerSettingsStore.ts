import { create } from 'zustand'
import type { ScopeKind } from '../../types/scopePopout'
import { SCOPE_KINDS, isScopeKind } from '../../types/scopePopout'
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
  type SpectrogramClarityMode,
  type SpectrogramScaleMode,
  type SpectrogramOrientation,
} from '../../types/spectrogram'
import {
  DEFAULT_LUFS_METER_MODE,
  isLUFSMeterMode,
  type LUFSMeterMode,
} from '../../types/lufsmeter'
import {
  DEFAULT_VU_METER_MODE,
  DEFAULT_VU_METER_ORIENTATION,
  isVUMeterOrientation,
  isVUMeterMode,
  type VUMeterMode,
  type VUMeterOrientation,
} from '../../types/vumeter'
import {
  DEFAULT_WAVEFORM_GAIN_DB,
  DEFAULT_WAVEFORM_SCROLL_SPEED,
  clampWaveformGainDb,
  clampWaveformScrollSpeed,
  isWaveformMode,
  DEFAULT_WAVEFORM_MODE,
  type WaveformMode,
} from '../../types/waveform'
import {
  DEFAULT_SPECTRUM_DISPLAY_MODE,
  DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_BAR_DENSITY,
  DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
  DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
  DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
  DEFAULT_SPECTRUM_HEAT_PALETTE,
  clampSpectrumTiltDbPerOctave,
  clampSpectrumHeatmapTiltDbPerOctave,
  clampSpectrumBarDensity,
  clampSpectrumBarGapPercent,
  clampSpectrumBarCornerRadiusPx,
  isSpectrumDisplayMode,
  isSpectrumHeatPalette,
  type SpectrumDisplayMode,
  type SpectrumHeatPalette,
} from '../../types/spectrum'

export type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384
export type OscilloscopeMode = 'classic' | 'locked'
export type VectorscopeMode = 'lissajous' | 'polar-unipolar' | 'polar-bipolar' | 'linear-unipolar' | 'linear-bipolar'

const VECTORSCOPE_MODES: readonly VectorscopeMode[] = [
  'lissajous', 'polar-unipolar', 'polar-bipolar', 'linear-unipolar', 'linear-bipolar'
]

export function isVectorscopeMode(value: unknown): value is VectorscopeMode {
  return typeof value === 'string' && VECTORSCOPE_MODES.includes(value as VectorscopeMode)
}

export const DEFAULT_SPECTRUM_SMOOTHING = 0.9
export const DEFAULT_SPECTRUM_HEATMAP_SMOOTHING = 0.5
export const MIN_SPECTRUM_SMOOTHING = 0
export const MAX_SPECTRUM_SMOOTHING = 0.99
export const SPECTRUM_SMOOTHING_STEP = 0.01

function clampSpectrumSmoothing(value: unknown, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(MAX_SPECTRUM_SMOOTHING, Math.max(MIN_SPECTRUM_SMOOTHING, numeric))
}

export interface AnalyzerProfileScopeSettings {
  spectrum: {
    fftSize: FFTSize
    displayMode: SpectrumDisplayMode
    tiltDbPerOctave: number
    heatmap: boolean
    heatmapTiltDbPerOctave: number
    showSideLine: boolean
    smoothing: number
    heatmapSmoothing: number
    barDensity: number
    barGapPercent: number
    barCornerRadiusPx: number
    showBarPeaks: boolean
    heatPalette: SpectrumHeatPalette
  }
  oscilloscope: {
    pitchLock: boolean
    underfillEnabled: boolean
    mode: OscilloscopeMode
  }
  vectorscope: {
    mode: VectorscopeMode
    multiband: boolean
  }
  spectrogram: {
    fftSize: FFTSize
    scrollSpeed: number
    clarityMode: SpectrogramClarityMode
    scaleMode: SpectrogramScaleMode
    tiltDbPerOctave: number
    contrast: number
    orientation: SpectrogramOrientation
  }
  vumeter: {
    mode: VUMeterMode
    orientation: VUMeterOrientation
  }
  lufsmeter: {
    mode: LUFSMeterMode
  }
  waveform: {
    scrollSpeed: number
    gainDb: number
    multiband: boolean
    mode: WaveformMode
  }
}

export interface AnalyzerWorkingState {
  order: ScopeKind[]
  hiddenScopes: ScopeKind[]
  widthWeights: Record<ScopeKind, number>
  scopeSettings: AnalyzerProfileScopeSettings
}

export interface AnalyzerProfile extends AnalyzerWorkingState {
  id: string
  name: string
  builtIn: boolean
}

interface LegacyAnalyzerPrefs {
  spectrumHeatmap: boolean
  vectorscopeMultiband: boolean
  waveformMultiband: boolean
}

interface VisualizerSettingsSnapshot {
  lineColor: string
  isRunning: boolean
  vectorscopeMultiband: boolean
  waveformMultiband: boolean
  spectrumHeatmap: boolean
  spectrumShowSideLine: boolean
  spectrumSmoothing: number
  spectrumHeatmapSmoothing: number
  spectrumDisplayMode: SpectrumDisplayMode
  spectrumTiltDbPerOctave: number
  spectrumHeatmapTiltDbPerOctave: number
  spectrumBarDensity: number
  spectrumBarGapPercent: number
  spectrumBarCornerRadiusPx: number
  spectrumShowBarPeaks: boolean
  spectrumHeatPalette: SpectrumHeatPalette
  profiles: Record<string, AnalyzerProfile>
  selectedProfileId: string
  selectedProfileName: string
  selectedProfileBuiltIn: boolean
  selectedProfileCanDelete: boolean
  hasUnsavedProfileChanges: boolean
  activeProfileId: string
  activeProfileName: string
  activeProfileBuiltIn: boolean
  activeProfileCanDelete: boolean
  workingState: AnalyzerWorkingState
  scopeOrder: ScopeKind[]
  hiddenScopes: ScopeKind[]
  widthWeights: Record<ScopeKind, number>
  fftSize: FFTSize
  spectrogramFftSize: FFTSize
  spectrogramScrollSpeed: number
  spectrogramClarityMode: SpectrogramClarityMode
  spectrogramScaleMode: SpectrogramScaleMode
  spectrogramTiltDbPerOctave: number
  spectrogramContrast: number
  spectrogramOrientation: SpectrogramOrientation
  waveformScrollSpeed: number
  waveformGainDb: number
  waveformMode: WaveformMode
  pitchLock: boolean
  oscilloscopeUnderfillEnabled: boolean
  oscilloscopeMode: OscilloscopeMode
  vectorscopeMode: VectorscopeMode
  vuMeterMode: VUMeterMode
  vuMeterOrientation: VUMeterOrientation
  lufsMeterMode: LUFSMeterMode
}

interface VisualizerSettingsStore extends VisualizerSettingsSnapshot {
  setLineColor: (color: string) => void
  setIsRunning: (running: boolean) => void
  setSelectedProfile: (profileId: string) => void
  setActiveProfile: (profileId: string) => void
  saveSelectedProfile: () => void
  saveCurrentProfileAs: (name: string) => SaveCurrentProfileAsResult
  saveCurrentProfile: (name: string) => SaveCurrentProfileAsResult
  revertToSelectedProfile: () => void
  deleteProfile: (profileId: string) => void
  moveScope: (scope: ScopeKind, direction: 'earlier' | 'later') => void
  setScopeDeckLayout: (order: ScopeKind[], hiddenScopes: ScopeKind[]) => void
  setScopeHidden: (scope: ScopeKind, hidden: boolean) => void
  setScopeWidthWeight: (scope: ScopeKind, weight: number) => void
  setScopeWidthWeights: (weights: Partial<Record<ScopeKind, number>>) => void
  setFftSize: (size: FFTSize) => void
  setSpectrogramFftSize: (size: FFTSize) => void
  setSpectrogramScrollSpeed: (speed: number) => void
  setSpectrogramClarityMode: (mode: SpectrogramClarityMode) => void
  setSpectrogramScaleMode: (mode: SpectrogramScaleMode) => void
  setSpectrogramTiltDbPerOctave: (value: number) => void
  setSpectrogramContrast: (value: number) => void
  setSpectrogramOrientation: (orientation: SpectrogramOrientation) => void
  setWaveformScrollSpeed: (speed: number) => void
  setWaveformGainDb: (gainDb: number) => void
  setPitchLock: (enabled: boolean) => void
  setOscilloscopeUnderfillEnabled: (enabled: boolean) => void
  setVectorscopeMode: (mode: VectorscopeMode) => void
  setVectorscopeMultiband: (enabled: boolean) => void
  setWaveformMultiband: (enabled: boolean) => void
  setWaveformMode: (mode: WaveformMode) => void
  setSpectrumDisplayMode: (mode: SpectrumDisplayMode) => void
  setSpectrumHeatmap: (enabled: boolean) => void
  setSpectrumShowSideLine: (enabled: boolean) => void
  setSpectrumSmoothing: (value: number) => void
  setSpectrumHeatmapSmoothing: (value: number) => void
  setSpectrumTiltDbPerOctave: (value: number) => void
  setSpectrumHeatmapTiltDbPerOctave: (value: number) => void
  setSpectrumBarDensity: (value: number) => void
  setSpectrumBarGapPercent: (value: number) => void
  setSpectrumBarCornerRadiusPx: (value: number) => void
  setSpectrumShowBarPeaks: (enabled: boolean) => void
  setSpectrumHeatPalette: (palette: SpectrumHeatPalette) => void
  setVUMeterMode: (mode: VUMeterMode) => void
  setVUMeterOrientation: (orientation: VUMeterOrientation) => void
  setLUFSMeterMode: (mode: LUFSMeterMode) => void
  resetToDefaults: () => void
}

interface PersistedAnalyzerEnvelopeV4 {
  version: 4
  selectedProfileId: string
  workingState: AnalyzerWorkingState
  profiles: AnalyzerProfile[]
}

type SaveCurrentProfileAsResult =
  | { ok: true; profileId: string }
  | { ok: false; error: string }

const FFT_SIZES: readonly FFTSize[] = [1024, 2048, 4096, 8192, 16384]

export const ANALYZER_PROFILE_STORAGE_VERSION = 4
export const ANALYZER_PROFILES_STORAGE_KEY = 'astra-analyzer-profiles-v1'
export const OSCILLOSCOPE_UNDERFILL_STORAGE_KEY = 'astra-oscilloscope-underfill-enabled'
export const VECTORSCOPE_MULTIBAND_STORAGE_KEY = 'astra-vectorscope-multiband'
export const WAVEFORM_MULTIBAND_STORAGE_KEY = 'astra-waveform-multiband'
export const SPECTRUM_HEATMAP_STORAGE_KEY = 'astra-spectrum-heatmap'

const DEFAULT_PROFILE_ID = 'default'
const DEFAULT_PROFILE_NAME = 'Default'
const DEFAULT_LINE_COLOR = '#38bdf8'
const DEFAULT_RUNNING = true
const DEFAULT_FFT_SIZE: FFTSize = 4096
const DEFAULT_PITCH_LOCK = true
const DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED = false
const DEFAULT_OSCILLOSCOPE_MODE: OscilloscopeMode = 'classic'
const DEFAULT_VECTORSCOPE_MODE: VectorscopeMode = 'lissajous'
const DEFAULT_SCOPE_ORDER: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope', 'spectrogram', 'waveform', 'vumeter', 'lufsmeter']
const DEFAULT_WIDTH_WEIGHTS: Record<ScopeKind, number> = {
  spectrum: 1,
  oscilloscope: 1.4,
  vectorscope: 0,
  spectrogram: 0,
  vumeter: 0,
  lufsmeter: 0,
  waveform: 0,
}

const MIN_WEIGHT = 0.4
const MAX_WEIGHT = 2.6

function isFFTSize(value: unknown): value is FFTSize {
  return typeof value === 'number' && FFT_SIZES.includes(value as FFTSize)
}

function cloneScopeSettings(settings: AnalyzerProfileScopeSettings): AnalyzerProfileScopeSettings {
  return {
    spectrum: { ...settings.spectrum },
    oscilloscope: { ...settings.oscilloscope },
    vectorscope: { ...settings.vectorscope },
    spectrogram: { ...settings.spectrogram },
    vumeter: { ...settings.vumeter },
    lufsmeter: { ...settings.lufsmeter },
    waveform: { ...settings.waveform },
  }
}

function cloneWorkingState(state: AnalyzerWorkingState): AnalyzerWorkingState {
  return {
    order: [...state.order],
    hiddenScopes: [...state.hiddenScopes],
    widthWeights: { ...state.widthWeights },
    scopeSettings: cloneScopeSettings(state.scopeSettings),
  }
}

function workingStateFromProfile(profile: AnalyzerProfile): AnalyzerWorkingState {
  return cloneWorkingState(profile)
}

function buildProfile(id: string, name: string, builtIn: boolean, state: AnalyzerWorkingState): AnalyzerProfile {
  const normalized = normalizeAnalyzerWorkingState(state)
  return {
    id,
    name,
    builtIn,
    ...normalized,
  }
}

const DEFAULT_WORKING_STATE: AnalyzerWorkingState = {
  order: [...DEFAULT_SCOPE_ORDER],
  hiddenScopes: ['spectrogram', 'waveform', 'vumeter', 'lufsmeter'],
  widthWeights: { ...DEFAULT_WIDTH_WEIGHTS },
  scopeSettings: {
    spectrum: {
      fftSize: DEFAULT_FFT_SIZE,
      displayMode: DEFAULT_SPECTRUM_DISPLAY_MODE,
      tiltDbPerOctave: DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
      heatmap: false,
      heatmapTiltDbPerOctave: DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
      showSideLine: false,
      smoothing: DEFAULT_SPECTRUM_SMOOTHING,
      heatmapSmoothing: DEFAULT_SPECTRUM_HEATMAP_SMOOTHING,
      barDensity: DEFAULT_SPECTRUM_BAR_DENSITY,
      barGapPercent: DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
      barCornerRadiusPx: DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
      showBarPeaks: DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
      heatPalette: DEFAULT_SPECTRUM_HEAT_PALETTE,
    },
    oscilloscope: {
      pitchLock: DEFAULT_PITCH_LOCK,
      underfillEnabled: DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED,
      mode: DEFAULT_OSCILLOSCOPE_MODE,
    },
    vectorscope: { mode: DEFAULT_VECTORSCOPE_MODE, multiband: false },
    spectrogram: {
      fftSize: 2048,
      scrollSpeed: DEFAULT_SPECTROGRAM_SCROLL_SPEED,
      clarityMode: DEFAULT_SPECTROGRAM_CLARITY_MODE,
      scaleMode: DEFAULT_SPECTROGRAM_SCALE_MODE,
      tiltDbPerOctave: DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE,
      contrast: DEFAULT_SPECTROGRAM_CONTRAST,
      orientation: DEFAULT_SPECTROGRAM_ORIENTATION,
    },
    vumeter: {
      mode: DEFAULT_VU_METER_MODE,
      orientation: DEFAULT_VU_METER_ORIENTATION,
    },
    lufsmeter: {
      mode: DEFAULT_LUFS_METER_MODE,
    },
    waveform: {
      scrollSpeed: DEFAULT_WAVEFORM_SCROLL_SPEED,
      gainDb: DEFAULT_WAVEFORM_GAIN_DB,
      multiband: false,
      mode: DEFAULT_WAVEFORM_MODE,
    },
  },
}

const BUILT_IN_PROFILES: Record<string, AnalyzerProfile> = {
  [DEFAULT_PROFILE_ID]: buildProfile(
    DEFAULT_PROFILE_ID,
    DEFAULT_PROFILE_NAME,
    true,
    DEFAULT_WORKING_STATE
  ),
}

function normalizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readLegacyOscilloscopeUnderfillPreference(): boolean {
  try {
    return localStorage.getItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY) === '1'
  } catch {
    return DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED
  }
}

function persistLegacyOscilloscopeUnderfillPreference(enabled: boolean): void {
  try {
    localStorage.setItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // ignore persistence failures
  }
}

function readVectorscopeMultibandPreference(): boolean {
  try {
    return localStorage.getItem(VECTORSCOPE_MULTIBAND_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function readWaveformMultibandPreference(): boolean {
  try {
    return localStorage.getItem(WAVEFORM_MULTIBAND_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function readSpectrumHeatmapPreference(): boolean {
  try {
    return localStorage.getItem(SPECTRUM_HEATMAP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function readLegacyAnalyzerPrefs(): LegacyAnalyzerPrefs {
  return {
    spectrumHeatmap: readSpectrumHeatmapPreference(),
    vectorscopeMultiband: readVectorscopeMultibandPreference(),
    waveformMultiband: readWaveformMultibandPreference(),
  }
}

function buildDefaultWorkingState(legacyAnalyzerPrefs: LegacyAnalyzerPrefs): AnalyzerWorkingState {
  return {
    order: [...DEFAULT_WORKING_STATE.order],
    hiddenScopes: [...DEFAULT_WORKING_STATE.hiddenScopes],
    widthWeights: { ...DEFAULT_WORKING_STATE.widthWeights },
    scopeSettings: {
      spectrum: {
        ...DEFAULT_WORKING_STATE.scopeSettings.spectrum,
        heatmap: legacyAnalyzerPrefs.spectrumHeatmap,
      },
      oscilloscope: { ...DEFAULT_WORKING_STATE.scopeSettings.oscilloscope },
      vectorscope: {
        ...DEFAULT_WORKING_STATE.scopeSettings.vectorscope,
        multiband: legacyAnalyzerPrefs.vectorscopeMultiband,
      },
      spectrogram: { ...DEFAULT_WORKING_STATE.scopeSettings.spectrogram },
      vumeter: { ...DEFAULT_WORKING_STATE.scopeSettings.vumeter },
      lufsmeter: { ...DEFAULT_WORKING_STATE.scopeSettings.lufsmeter },
      waveform: {
        ...DEFAULT_WORKING_STATE.scopeSettings.waveform,
        multiband: legacyAnalyzerPrefs.waveformMultiband,
      },
    },
  }
}

function clampWidthWeight(scope: ScopeKind, value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_WIDTH_WEIGHTS[scope]

  if ((scope === 'vectorscope' || scope === 'spectrogram' || scope === 'waveform' || scope === 'vumeter' || scope === 'lufsmeter') && numeric <= 0) {
    return 0
  }

  const rounded = Math.round(numeric * 100) / 100
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, rounded))
}

function normalizeOrder(value: unknown): ScopeKind[] {
  const out: ScopeKind[] = []

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isScopeKind(item) || out.includes(item)) continue
      out.push(item)
    }
  }

  for (const scope of DEFAULT_SCOPE_ORDER) {
    if (!out.includes(scope)) {
      out.push(scope)
    }
  }

  return out
}

function normalizeHiddenScopes(value: unknown, order: ScopeKind[]): ScopeKind[] {
  if (!Array.isArray(value)) return []

  const hiddenSet = new Set<ScopeKind>()
  for (const item of value) {
    if (isScopeKind(item)) {
      hiddenSet.add(item)
    }
  }

  return order.filter((scope) => hiddenSet.has(scope))
}

function normalizeScopeSettings(
  value: unknown,
  legacyUnderfillEnabled: boolean,
  legacyAnalyzerPrefs?: LegacyAnalyzerPrefs
): AnalyzerProfileScopeSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  const rawSpectrum = raw.spectrum && typeof raw.spectrum === 'object' && !Array.isArray(raw.spectrum)
    ? raw.spectrum as Record<string, unknown>
    : {}

  const rawOscilloscope = raw.oscilloscope && typeof raw.oscilloscope === 'object' && !Array.isArray(raw.oscilloscope)
    ? raw.oscilloscope as Record<string, unknown>
    : {}

  const rawVectorscope = raw.vectorscope && typeof raw.vectorscope === 'object' && !Array.isArray(raw.vectorscope)
    ? raw.vectorscope as Record<string, unknown>
    : {}

  const rawSpectrogram = raw.spectrogram && typeof raw.spectrogram === 'object' && !Array.isArray(raw.spectrogram)
    ? raw.spectrogram as Record<string, unknown>
    : {}

  const rawVumeter = raw.vumeter && typeof raw.vumeter === 'object' && !Array.isArray(raw.vumeter)
    ? raw.vumeter as Record<string, unknown>
    : {}

  const rawLufsmeter = raw.lufsmeter && typeof raw.lufsmeter === 'object' && !Array.isArray(raw.lufsmeter)
    ? raw.lufsmeter as Record<string, unknown>
    : {}

  const rawWaveform = raw.waveform && typeof raw.waveform === 'object' && !Array.isArray(raw.waveform)
    ? raw.waveform as Record<string, unknown>
    : {}

  const fallbackUnderfill = raw.oscilloscopeUnderfillEnabled
  const underfillEnabled = typeof rawOscilloscope.underfillEnabled === 'boolean'
    ? rawOscilloscope.underfillEnabled
    : typeof fallbackUnderfill === 'boolean'
      ? fallbackUnderfill
      : legacyUnderfillEnabled

  const fallbackPitchLock = raw.pitchLock
  const fallbackFftSize = raw.fftSize
  const fallbackOscilloscopeMode = raw.oscilloscopeMode
  const fallbackVectorscopeMode = raw.vectorscopeMode

  const fftSizeValue = rawSpectrum.fftSize ?? fallbackFftSize
  const oscilloscopeModeValue = rawOscilloscope.mode ?? fallbackOscilloscopeMode
  const vectorscopeModeValue = rawVectorscope.mode ?? fallbackVectorscopeMode

  return {
    spectrum: {
      fftSize: isFFTSize(fftSizeValue) ? fftSizeValue : DEFAULT_FFT_SIZE,
      displayMode: isSpectrumDisplayMode(rawSpectrum.displayMode)
        ? rawSpectrum.displayMode
        : DEFAULT_SPECTRUM_DISPLAY_MODE,
      tiltDbPerOctave: clampSpectrumTiltDbPerOctave(rawSpectrum.tiltDbPerOctave),
      heatmap: typeof rawSpectrum.heatmap === 'boolean'
        ? rawSpectrum.heatmap
        : legacyAnalyzerPrefs?.spectrumHeatmap ?? false,
      heatmapTiltDbPerOctave: clampSpectrumHeatmapTiltDbPerOctave(rawSpectrum.heatmapTiltDbPerOctave),
      showSideLine: typeof rawSpectrum.showSideLine === 'boolean' ? rawSpectrum.showSideLine : false,
      smoothing: clampSpectrumSmoothing(rawSpectrum.smoothing, DEFAULT_SPECTRUM_SMOOTHING),
      heatmapSmoothing: clampSpectrumSmoothing(rawSpectrum.heatmapSmoothing, DEFAULT_SPECTRUM_HEATMAP_SMOOTHING),
      barDensity: clampSpectrumBarDensity(rawSpectrum.barDensity),
      barGapPercent: clampSpectrumBarGapPercent(rawSpectrum.barGapPercent),
      barCornerRadiusPx: clampSpectrumBarCornerRadiusPx(rawSpectrum.barCornerRadiusPx),
      showBarPeaks: typeof rawSpectrum.showBarPeaks === 'boolean'
        ? rawSpectrum.showBarPeaks
        : DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
      heatPalette: isSpectrumHeatPalette(rawSpectrum.heatPalette)
        ? rawSpectrum.heatPalette
        : DEFAULT_SPECTRUM_HEAT_PALETTE,
    },
    oscilloscope: {
      pitchLock: typeof rawOscilloscope.pitchLock === 'boolean'
        ? rawOscilloscope.pitchLock
        : typeof fallbackPitchLock === 'boolean'
          ? fallbackPitchLock
          : DEFAULT_PITCH_LOCK,
      underfillEnabled,
      mode: oscilloscopeModeValue === 'locked' ? 'locked' : DEFAULT_OSCILLOSCOPE_MODE,
    },
    vectorscope: {
      mode: isVectorscopeMode(vectorscopeModeValue) ? vectorscopeModeValue : DEFAULT_VECTORSCOPE_MODE,
      multiband: typeof rawVectorscope.multiband === 'boolean'
        ? rawVectorscope.multiband
        : legacyAnalyzerPrefs?.vectorscopeMultiband ?? false,
    },
    spectrogram: {
      fftSize: isFFTSize(rawSpectrogram.fftSize) ? rawSpectrogram.fftSize : DEFAULT_FFT_SIZE,
      scrollSpeed: clampSpectrogramScrollSpeed(rawSpectrogram.scrollSpeed),
      clarityMode: isSpectrogramClarityMode(rawSpectrogram.clarityMode)
        ? rawSpectrogram.clarityMode
        : DEFAULT_SPECTROGRAM_CLARITY_MODE,
      scaleMode: isSpectrogramScaleMode(rawSpectrogram.scaleMode)
        ? rawSpectrogram.scaleMode
        : DEFAULT_SPECTROGRAM_SCALE_MODE,
      tiltDbPerOctave: clampSpectrogramTiltDbPerOctave(rawSpectrogram.tiltDbPerOctave),
      contrast: clampSpectrogramContrast(rawSpectrogram.contrast),
      orientation: isSpectrogramOrientation(rawSpectrogram.orientation)
        ? rawSpectrogram.orientation
        : DEFAULT_SPECTROGRAM_ORIENTATION,
    },
    vumeter: {
      mode: isVUMeterMode(rawVumeter.mode) ? rawVumeter.mode : DEFAULT_VU_METER_MODE,
      orientation: isVUMeterOrientation(rawVumeter.orientation)
        ? rawVumeter.orientation
        : DEFAULT_VU_METER_ORIENTATION,
    },
    lufsmeter: {
      mode: isLUFSMeterMode(rawLufsmeter.mode) ? rawLufsmeter.mode : DEFAULT_LUFS_METER_MODE,
    },
    waveform: {
      scrollSpeed: clampWaveformScrollSpeed(rawWaveform.scrollSpeed),
      gainDb: clampWaveformGainDb(rawWaveform.gainDb),
      multiband: typeof rawWaveform.multiband === 'boolean'
        ? rawWaveform.multiband
        : legacyAnalyzerPrefs?.waveformMultiband ?? false,
      mode: isWaveformMode(rawWaveform.mode) ? rawWaveform.mode : DEFAULT_WAVEFORM_MODE,
    },
  }
}

export function normalizeAnalyzerWorkingState(
  value: unknown,
  legacyUnderfillEnabled = DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED,
  legacyAnalyzerPrefs?: LegacyAnalyzerPrefs
): AnalyzerWorkingState {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  const order = normalizeOrder(raw.order ?? raw.scopeOrder)
  const hiddenScopes = normalizeHiddenScopes(raw.hiddenScopes, order)
  const rawWeights = raw.widthWeights && typeof raw.widthWeights === 'object'
    ? raw.widthWeights as Record<string, unknown>
    : {}
  const widthWeights = {
    spectrum: clampWidthWeight('spectrum', rawWeights.spectrum),
    oscilloscope: clampWidthWeight('oscilloscope', rawWeights.oscilloscope),
    vectorscope: clampWidthWeight('vectorscope', rawWeights.vectorscope),
    spectrogram: clampWidthWeight('spectrogram', rawWeights.spectrogram),
    vumeter: clampWidthWeight('vumeter', rawWeights.vumeter),
    lufsmeter: clampWidthWeight('lufsmeter', rawWeights.lufsmeter),
    waveform: clampWidthWeight('waveform', rawWeights.waveform),
  }

  // Auto-hide scopes that default to weight 0 and weren't explicitly saved
  // in the profile (i.e., the profile predates this scope being added).
  for (const scope of SCOPE_KINDS) {
    if (
      DEFAULT_WIDTH_WEIGHTS[scope] === 0 &&
      !(scope in rawWeights) &&
      !hiddenScopes.includes(scope)
    ) {
      hiddenScopes.push(scope)
    }
  }

  return {
    order,
    hiddenScopes,
    widthWeights,
    scopeSettings: normalizeScopeSettings(raw.scopeSettings ?? raw, legacyUnderfillEnabled, legacyAnalyzerPrefs),
  }
}

function normalizeProfile(
  value: unknown,
  legacyUnderfillEnabled: boolean,
  legacyAnalyzerPrefs?: LegacyAnalyzerPrefs,
  fallbackId?: string
): AnalyzerProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const id = normalizeProfileId(raw.id) ?? normalizeProfileId(fallbackId)
  if (!id) return null

  return buildProfile(
    id,
    normalizeProfileName(raw.name, id),
    Boolean(raw.builtIn),
    normalizeAnalyzerWorkingState(raw, legacyUnderfillEnabled, legacyAnalyzerPrefs)
  )
}

function normalizePersistedProfiles(
  value: unknown,
  legacyUnderfillEnabled: boolean,
  legacyAnalyzerPrefs?: LegacyAnalyzerPrefs
): Record<string, AnalyzerProfile> {
  const out: Record<string, AnalyzerProfile> = {}

  if (Array.isArray(value)) {
    for (const item of value) {
      const profile = normalizeProfile(item, legacyUnderfillEnabled, legacyAnalyzerPrefs)
      if (!profile) continue
      out[profile.id] = profile
    }
    return out
  }

  if (!value || typeof value !== 'object') {
    return out
  }

  for (const [profileId, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    const profile = normalizeProfile(rawProfile, legacyUnderfillEnabled, legacyAnalyzerPrefs, profileId)
    if (!profile) continue
    out[profile.id] = profile
  }

  return out
}

function mergeProfiles(persistedProfiles: Record<string, AnalyzerProfile>): Record<string, AnalyzerProfile> {
  const merged: Record<string, AnalyzerProfile> = {}

  for (const builtInProfile of Object.values(BUILT_IN_PROFILES)) {
    merged[builtInProfile.id] = buildProfile(
      builtInProfile.id,
      builtInProfile.name,
      true,
      builtInProfile
    )
  }

  for (const profile of Object.values(persistedProfiles)) {
    if (profile.builtIn && profile.id in BUILT_IN_PROFILES) {
      continue
    }
    merged[profile.id] = buildProfile(profile.id, profile.name, Boolean(profile.builtIn), profile)
  }

  return merged
}

function areWorkingStatesEqual(left: AnalyzerWorkingState, right: AnalyzerWorkingState): boolean {
  if (left.order.length !== right.order.length || left.hiddenScopes.length !== right.hiddenScopes.length) {
    return false
  }

  for (let index = 0; index < left.order.length; index += 1) {
    if (left.order[index] !== right.order[index]) return false
  }

  for (let index = 0; index < left.hiddenScopes.length; index += 1) {
    if (left.hiddenScopes[index] !== right.hiddenScopes[index]) return false
  }

  for (const scope of SCOPE_KINDS) {
    if (left.widthWeights[scope] !== right.widthWeights[scope]) return false
  }

  return (
    left.scopeSettings.spectrum.fftSize === right.scopeSettings.spectrum.fftSize
    && left.scopeSettings.spectrum.displayMode === right.scopeSettings.spectrum.displayMode
    && left.scopeSettings.spectrum.tiltDbPerOctave === right.scopeSettings.spectrum.tiltDbPerOctave
    && left.scopeSettings.spectrum.heatmap === right.scopeSettings.spectrum.heatmap
    && left.scopeSettings.spectrum.heatmapTiltDbPerOctave === right.scopeSettings.spectrum.heatmapTiltDbPerOctave
    && left.scopeSettings.spectrum.showSideLine === right.scopeSettings.spectrum.showSideLine
    && left.scopeSettings.spectrum.smoothing === right.scopeSettings.spectrum.smoothing
    && left.scopeSettings.spectrum.heatmapSmoothing === right.scopeSettings.spectrum.heatmapSmoothing
    && left.scopeSettings.spectrum.barDensity === right.scopeSettings.spectrum.barDensity
    && left.scopeSettings.spectrum.barGapPercent === right.scopeSettings.spectrum.barGapPercent
    && left.scopeSettings.spectrum.barCornerRadiusPx === right.scopeSettings.spectrum.barCornerRadiusPx
    && left.scopeSettings.spectrum.showBarPeaks === right.scopeSettings.spectrum.showBarPeaks
    && left.scopeSettings.spectrum.heatPalette === right.scopeSettings.spectrum.heatPalette
    && left.scopeSettings.oscilloscope.pitchLock === right.scopeSettings.oscilloscope.pitchLock
    && left.scopeSettings.oscilloscope.underfillEnabled === right.scopeSettings.oscilloscope.underfillEnabled
    && left.scopeSettings.oscilloscope.mode === right.scopeSettings.oscilloscope.mode
    && left.scopeSettings.vectorscope.mode === right.scopeSettings.vectorscope.mode
    && left.scopeSettings.vectorscope.multiband === right.scopeSettings.vectorscope.multiband
    && left.scopeSettings.spectrogram.fftSize === right.scopeSettings.spectrogram.fftSize
    && left.scopeSettings.spectrogram.scrollSpeed === right.scopeSettings.spectrogram.scrollSpeed
    && left.scopeSettings.spectrogram.clarityMode === right.scopeSettings.spectrogram.clarityMode
    && left.scopeSettings.spectrogram.scaleMode === right.scopeSettings.spectrogram.scaleMode
    && left.scopeSettings.spectrogram.tiltDbPerOctave === right.scopeSettings.spectrogram.tiltDbPerOctave
    && left.scopeSettings.spectrogram.contrast === right.scopeSettings.spectrogram.contrast
    && left.scopeSettings.spectrogram.orientation === right.scopeSettings.spectrogram.orientation
    && left.scopeSettings.vumeter.mode === right.scopeSettings.vumeter.mode
    && left.scopeSettings.vumeter.orientation === right.scopeSettings.vumeter.orientation
    && left.scopeSettings.lufsmeter.mode === right.scopeSettings.lufsmeter.mode
    && left.scopeSettings.waveform.scrollSpeed === right.scopeSettings.waveform.scrollSpeed
    && left.scopeSettings.waveform.gainDb === right.scopeSettings.waveform.gainDb
    && left.scopeSettings.waveform.multiband === right.scopeSettings.waveform.multiband
    && left.scopeSettings.waveform.mode === right.scopeSettings.waveform.mode
  )
}

function serializeProfile(profile: AnalyzerProfile): AnalyzerProfile {
  return {
    id: profile.id,
    name: profile.name,
    builtIn: profile.builtIn,
    ...cloneWorkingState(profile),
  }
}

function persistState(
  profiles: Record<string, AnalyzerProfile>,
  selectedProfileId: string,
  workingState: AnalyzerWorkingState
): void {
  const payload: PersistedAnalyzerEnvelopeV4 = {
    version: ANALYZER_PROFILE_STORAGE_VERSION,
    selectedProfileId,
    workingState: cloneWorkingState(workingState),
    profiles: Object.values(profiles)
      .filter((profile) => !profile.builtIn)
      .map(serializeProfile),
  }

  try {
    localStorage.setItem(ANALYZER_PROFILES_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn('Failed to persist analyzer profiles:', error)
  }

  persistLegacyOscilloscopeUnderfillPreference(
    workingState.scopeSettings.oscilloscope.underfillEnabled
  )
}

function makeProfileId(profiles: Record<string, AnalyzerProfile>): string {
  let attempt = `custom-${Date.now()}`
  let sequence = 1

  while (profiles[attempt]) {
    attempt = `custom-${Date.now()}-${sequence}`
    sequence += 1
  }

  return attempt
}

function buildSnapshot(
  lineColor: string,
  isRunning: boolean,
  profilesInput: Record<string, AnalyzerProfile>,
  requestedSelectedProfileId: string | null,
  workingStateInput: AnalyzerWorkingState,
): VisualizerSettingsSnapshot {
  const profiles = mergeProfiles(profilesInput)
  const workingState = normalizeAnalyzerWorkingState(workingStateInput)
  const normalizedSelectedProfileId = normalizeProfileId(requestedSelectedProfileId)
  const selectedProfile = normalizedSelectedProfileId
    ? profiles[normalizedSelectedProfileId] ?? null
    : null
  const resolvedSelectedProfile = selectedProfile ?? profiles[DEFAULT_PROFILE_ID]
  const selectedProfileId = resolvedSelectedProfile.id
  const hasUnsavedProfileChanges = !areWorkingStatesEqual(
    workingStateFromProfile(resolvedSelectedProfile),
    workingState
  )
  const selectedProfileCanDelete = !resolvedSelectedProfile.builtIn && !hasUnsavedProfileChanges

  return {
    lineColor,
    isRunning,
    vectorscopeMultiband: workingState.scopeSettings.vectorscope.multiband,
    waveformMultiband: workingState.scopeSettings.waveform.multiband,
    spectrumHeatmap: workingState.scopeSettings.spectrum.heatmap,
    spectrumShowSideLine: workingState.scopeSettings.spectrum.showSideLine,
    spectrumSmoothing: workingState.scopeSettings.spectrum.smoothing,
    spectrumHeatmapSmoothing: workingState.scopeSettings.spectrum.heatmapSmoothing,
    spectrumDisplayMode: workingState.scopeSettings.spectrum.displayMode,
    spectrumTiltDbPerOctave: workingState.scopeSettings.spectrum.tiltDbPerOctave,
    spectrumHeatmapTiltDbPerOctave: workingState.scopeSettings.spectrum.heatmapTiltDbPerOctave,
    spectrumBarDensity: workingState.scopeSettings.spectrum.barDensity,
    spectrumBarGapPercent: workingState.scopeSettings.spectrum.barGapPercent,
    spectrumBarCornerRadiusPx: workingState.scopeSettings.spectrum.barCornerRadiusPx,
    spectrumShowBarPeaks: workingState.scopeSettings.spectrum.showBarPeaks,
    spectrumHeatPalette: workingState.scopeSettings.spectrum.heatPalette,
    profiles,
    selectedProfileId,
    selectedProfileName: resolvedSelectedProfile.name,
    selectedProfileBuiltIn: resolvedSelectedProfile.builtIn,
    selectedProfileCanDelete,
    hasUnsavedProfileChanges,
    activeProfileId: selectedProfileId,
    activeProfileName: resolvedSelectedProfile.name,
    activeProfileBuiltIn: resolvedSelectedProfile.builtIn,
    activeProfileCanDelete: selectedProfileCanDelete,
    workingState,
    scopeOrder: [...workingState.order],
    hiddenScopes: [...workingState.hiddenScopes],
    widthWeights: { ...workingState.widthWeights },
    fftSize: workingState.scopeSettings.spectrum.fftSize,
    spectrogramFftSize: workingState.scopeSettings.spectrogram.fftSize,
    spectrogramScrollSpeed: workingState.scopeSettings.spectrogram.scrollSpeed,
    spectrogramClarityMode: workingState.scopeSettings.spectrogram.clarityMode,
    spectrogramScaleMode: workingState.scopeSettings.spectrogram.scaleMode,
    spectrogramTiltDbPerOctave: workingState.scopeSettings.spectrogram.tiltDbPerOctave,
    spectrogramContrast: workingState.scopeSettings.spectrogram.contrast,
    spectrogramOrientation: workingState.scopeSettings.spectrogram.orientation,
    waveformScrollSpeed: workingState.scopeSettings.waveform.scrollSpeed,
    waveformGainDb: workingState.scopeSettings.waveform.gainDb,
    waveformMode: workingState.scopeSettings.waveform.mode,
    pitchLock: workingState.scopeSettings.oscilloscope.pitchLock,
    oscilloscopeUnderfillEnabled: workingState.scopeSettings.oscilloscope.underfillEnabled,
    oscilloscopeMode: workingState.scopeSettings.oscilloscope.mode,
    vectorscopeMode: workingState.scopeSettings.vectorscope.mode,
    vuMeterMode: workingState.scopeSettings.vumeter.mode,
    vuMeterOrientation: workingState.scopeSettings.vumeter.orientation,
    lufsMeterMode: workingState.scopeSettings.lufsmeter.mode,
  }
}

function loadInitialSnapshot(): VisualizerSettingsSnapshot {
  const legacyUnderfillEnabled = readLegacyOscilloscopeUnderfillPreference()
  const legacyAnalyzerPrefs = readLegacyAnalyzerPrefs()

  try {
    const raw = localStorage.getItem(ANALYZER_PROFILES_STORAGE_KEY)
    if (!raw) {
      const workingState = buildDefaultWorkingState(legacyAnalyzerPrefs)
      return buildSnapshot(
        DEFAULT_LINE_COLOR,
        DEFAULT_RUNNING,
        BUILT_IN_PROFILES,
        DEFAULT_PROFILE_ID,
        workingState
      )
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>
    const persistedProfiles = normalizePersistedProfiles(parsed.profiles, legacyUnderfillEnabled, legacyAnalyzerPrefs)
    const mergedProfiles = mergeProfiles(persistedProfiles)

    const requestedSelectedProfileId = normalizeProfileId(parsed.selectedProfileId)
      ?? normalizeProfileId(parsed.activeProfileId)
      ?? DEFAULT_PROFILE_ID
    const baseWorkingState = parsed.workingState !== undefined
      ? normalizeAnalyzerWorkingState(parsed.workingState, legacyUnderfillEnabled, legacyAnalyzerPrefs)
      : requestedSelectedProfileId && mergedProfiles[requestedSelectedProfileId]
        ? requestedSelectedProfileId in BUILT_IN_PROFILES
          ? buildDefaultWorkingState(legacyAnalyzerPrefs)
          : workingStateFromProfile(mergedProfiles[requestedSelectedProfileId])
        : buildDefaultWorkingState(legacyAnalyzerPrefs)

    return buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      mergedProfiles,
      requestedSelectedProfileId,
      baseWorkingState
    )
  } catch {
    const workingState = buildDefaultWorkingState(legacyAnalyzerPrefs)
    return buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      BUILT_IN_PROFILES,
      DEFAULT_PROFILE_ID,
      workingState
    )
  }
}

function updateWorkingState(
  state: VisualizerSettingsStore,
  nextWorkingStateInput: AnalyzerWorkingState
): VisualizerSettingsSnapshot {
  const nextWorkingState = normalizeAnalyzerWorkingState(nextWorkingStateInput)
  return buildSnapshot(
    state.lineColor,
    state.isRunning,
    state.profiles,
    state.selectedProfileId,
    nextWorkingState
  )
}

const initialSnapshot = loadInitialSnapshot()

export const useVisualizerSettingsStore = create<VisualizerSettingsStore>((set, get) => ({
  ...initialSnapshot,

  setLineColor: (color) => {
    set({ lineColor: color })
  },

  setIsRunning: (running) => {
    set({ isRunning: running })
  },

  setSelectedProfile: (profileId) => {
    const targetId = normalizeProfileId(profileId)
    if (!targetId) return

    const state = get()
    const profile = state.profiles[targetId]
    if (!profile) return

    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      state.profiles,
      targetId,
      workingStateFromProfile(profile)
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setActiveProfile: (profileId) => {
    get().setSelectedProfile(profileId)
  },

  saveSelectedProfile: () => {
    const state = get()
    const selectedProfile = state.profiles[state.selectedProfileId]
    if (!selectedProfile || selectedProfile.builtIn || !state.hasUnsavedProfileChanges) return

    const nextProfiles = {
      ...state.profiles,
      [selectedProfile.id]: buildProfile(selectedProfile.id, selectedProfile.name, false, state.workingState),
    }

    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      nextProfiles,
      selectedProfile.id,
      state.workingState
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  saveCurrentProfileAs: (name) => {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: 'Enter a profile name.' }
    }

    const state = get()
    const existingEntry = Object.values(state.profiles).find(
      (p) => !p.builtIn && p.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (existingEntry) {
      return { ok: false, error: 'Profile name already exists.' }
    }

    const profileId = makeProfileId(state.profiles)

    const nextProfiles = {
      ...state.profiles,
      [profileId]: buildProfile(profileId, trimmed, false, state.workingState),
    }

    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      nextProfiles,
      profileId,
      state.workingState
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
    return { ok: true, profileId }
  },

  saveCurrentProfile: (name) => {
    return get().saveCurrentProfileAs(name)
  },

  revertToSelectedProfile: () => {
    const state = get()
    const selectedProfile = state.profiles[state.selectedProfileId] ?? BUILT_IN_PROFILES[DEFAULT_PROFILE_ID]
    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      state.profiles,
      selectedProfile.id,
      workingStateFromProfile(selectedProfile)
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  deleteProfile: (profileId) => {
    const targetId = normalizeProfileId(profileId)
    if (!targetId) return

    const state = get()
    const profile = state.profiles[targetId]
    if (!profile || profile.builtIn) return

    const { [targetId]: _removed, ...remainingProfiles } = state.profiles
    const deletingSelectedProfile = state.selectedProfileId === targetId
    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      remainingProfiles,
      deletingSelectedProfile ? DEFAULT_PROFILE_ID : state.selectedProfileId,
      deletingSelectedProfile
        ? workingStateFromProfile(BUILT_IN_PROFILES[DEFAULT_PROFILE_ID])
        : state.workingState
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  moveScope: (scope, direction) => {
    const state = get()
    const index = state.scopeOrder.indexOf(scope)
    if (index === -1) return

    const nextIndex = direction === 'earlier' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= state.scopeOrder.length) return

    const nextOrder = [...state.scopeOrder]
    const [movedScope] = nextOrder.splice(index, 1)
    nextOrder.splice(nextIndex, 0, movedScope)

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      order: nextOrder,
      hiddenScopes: nextOrder.filter((item) => state.hiddenScopes.includes(item)),
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeDeckLayout: (order, hiddenScopes) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      order,
      hiddenScopes,
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeHidden: (scope, hidden) => {
    const state = get()
    const hiddenSet = new Set(state.hiddenScopes)

    if (hidden) {
      hiddenSet.add(scope)
    } else {
      hiddenSet.delete(scope)
    }

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      hiddenScopes: state.scopeOrder.filter((item) => hiddenSet.has(item)),
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeWidthWeight: (scope, weight) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      widthWeights: {
        ...state.widthWeights,
        [scope]: clampWidthWeight(scope, weight),
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeWidthWeights: (weights) => {
    const state = get()
    const nextWidthWeights: Record<ScopeKind, number> = {
      ...state.widthWeights,
    }

    for (const scope of SCOPE_KINDS) {
      const weight = weights[scope]
      if (weight === undefined) continue
      nextWidthWeights[scope] = clampWidthWeight(scope, weight)
    }

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      widthWeights: nextWidthWeights,
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setFftSize: (size) => {
    if (!isFFTSize(size)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          fftSize: size,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramFftSize: (size) => {
    if (!isFFTSize(size)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          fftSize: size,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramScrollSpeed: (speed) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          scrollSpeed: clampSpectrogramScrollSpeed(speed),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramClarityMode: (mode) => {
    if (!isSpectrogramClarityMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          clarityMode: mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramScaleMode: (mode) => {
    if (!isSpectrogramScaleMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          scaleMode: mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramTiltDbPerOctave: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          tiltDbPerOctave: clampSpectrogramTiltDbPerOctave(value),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramContrast: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          contrast: clampSpectrogramContrast(value),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrogramOrientation: (orientation) => {
    if (!isSpectrogramOrientation(orientation)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrogram: {
          ...state.workingState.scopeSettings.spectrogram,
          orientation,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setWaveformScrollSpeed: (speed) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        waveform: {
          ...state.workingState.scopeSettings.waveform,
          scrollSpeed: clampWaveformScrollSpeed(speed),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setWaveformGainDb: (gainDb) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        waveform: {
          ...state.workingState.scopeSettings.waveform,
          gainDb: clampWaveformGainDb(gainDb),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setPitchLock: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        oscilloscope: {
          ...state.workingState.scopeSettings.oscilloscope,
          pitchLock: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setOscilloscopeUnderfillEnabled: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        oscilloscope: {
          ...state.workingState.scopeSettings.oscilloscope,
          underfillEnabled: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVectorscopeMode: (mode) => {
    if (!isVectorscopeMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        vectorscope: {
          ...state.workingState.scopeSettings.vectorscope,
          mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVectorscopeMultiband: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        vectorscope: {
          ...state.workingState.scopeSettings.vectorscope,
          multiband: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setWaveformMultiband: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        waveform: {
          ...state.workingState.scopeSettings.waveform,
          multiband: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setWaveformMode: (mode) => {
    if (!isWaveformMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        waveform: {
          ...state.workingState.scopeSettings.waveform,
          mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumDisplayMode: (mode) => {
    if (!isSpectrumDisplayMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          displayMode: mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumHeatmap: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          heatmap: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumShowSideLine: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          showSideLine: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumSmoothing: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          smoothing: clampSpectrumSmoothing(value, DEFAULT_SPECTRUM_SMOOTHING),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumHeatmapSmoothing: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          heatmapSmoothing: clampSpectrumSmoothing(value, DEFAULT_SPECTRUM_HEATMAP_SMOOTHING),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumTiltDbPerOctave: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          tiltDbPerOctave: clampSpectrumTiltDbPerOctave(value),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumHeatmapTiltDbPerOctave: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          heatmapTiltDbPerOctave: clampSpectrumHeatmapTiltDbPerOctave(value),
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumBarDensity: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          barDensity: clampSpectrumBarDensity(value),
        },
      },
    })
    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumBarGapPercent: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          barGapPercent: clampSpectrumBarGapPercent(value),
        },
      },
    })
    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumBarCornerRadiusPx: (value) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          barCornerRadiusPx: clampSpectrumBarCornerRadiusPx(value),
        },
      },
    })
    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumShowBarPeaks: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          showBarPeaks: enabled,
        },
      },
    })
    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setSpectrumHeatPalette: (palette) => {
    if (!isSpectrumHeatPalette(palette)) return
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          heatPalette: palette,
        },
      },
    })
    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVUMeterMode: (mode) => {
    if (!isVUMeterMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        vumeter: {
          ...state.workingState.scopeSettings.vumeter,
          mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVUMeterOrientation: (orientation) => {
    if (!isVUMeterOrientation(orientation)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        vumeter: {
          ...state.workingState.scopeSettings.vumeter,
          orientation,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setLUFSMeterMode: (mode) => {
    if (!isLUFSMeterMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        lufsmeter: {
          ...state.workingState.scopeSettings.lufsmeter,
          mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  resetToDefaults: () => {
    const nextSnapshot = buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      BUILT_IN_PROFILES,
      DEFAULT_PROFILE_ID,
      DEFAULT_WORKING_STATE
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },
}))

export function getActiveAnalyzerProfile(): AnalyzerProfile | null {
  const state = useVisualizerSettingsStore.getState()
  return state.profiles[state.selectedProfileId] ?? null
}
