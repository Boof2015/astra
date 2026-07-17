import type { MultichannelAudioChunk } from './audioAnalysis'
import type { LUFSMeterMode } from './lufsmeter'
import type { SpectrumDisplayMode, SpectrumHeatPalette } from './spectrum'
import type { SpectrogramClarityMode, SpectrogramScaleMode, SpectrogramOrientation } from './spectrogram'
import type { VUMeterMode, VUMeterOrientation } from './vumeter'

export type ScopeKind = 'spectrum' | 'oscilloscope' | 'vectorscope' | 'spectrogram' | 'vumeter' | 'lufsmeter' | 'waveform'

export const SCOPE_KINDS: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope', 'spectrogram', 'vumeter', 'lufsmeter', 'waveform']

export interface ScopePopoutState {
  spectrum: boolean
  oscilloscope: boolean
  vectorscope: boolean
  spectrogram: boolean
  vumeter: boolean
  lufsmeter: boolean
  waveform: boolean
}

export const DEFAULT_SCOPE_POPOUT_STATE: ScopePopoutState = {
  spectrum: false,
  oscilloscope: false,
  vectorscope: false,
  spectrogram: false,
  vumeter: false,
  lufsmeter: false,
  waveform: false,
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'spectrum' || value === 'oscilloscope' || value === 'vectorscope' || value === 'spectrogram' || value === 'vumeter' || value === 'lufsmeter' || value === 'waveform'
}

interface ScopePopoutChunkBase {
  scope: ScopeKind
  capturedAt: number
  sampleRate: number
  lineColor: string
  reset: boolean
}

export interface ScopePopoutSpectrumChunk extends ScopePopoutChunkBase {
  scope: 'spectrum'
  monoChunks: Float32Array[]
  fftSize: number
  spectrumDisplayMode: SpectrumDisplayMode
  spectrumTiltDbPerOctave: number
  spectrumHeatmap: boolean
  spectrumHeatmapTiltDbPerOctave: number
  spectrumSmoothing: number
  spectrumHeatmapSmoothing: number
  spectrumBarDensity: number
  spectrumBarGapPercent: number
  spectrumBarCornerRadiusPx: number
  spectrumShowBarPeaks: boolean
  spectrumHeatPalette: SpectrumHeatPalette
  spectrumHeatColors: [string, string, string]
}

export interface ScopePopoutOscilloscopeChunk extends ScopePopoutChunkBase {
  scope: 'oscilloscope'
  leftChunks: Float32Array[]
  pitchLock: boolean
  oscilloscopeUnderfillEnabled: boolean
}

export interface ScopePopoutVectorscopeChunk extends ScopePopoutChunkBase {
  scope: 'vectorscope'
  stereoChunks: Array<{
    left: Float32Array
    right: Float32Array
  }>
  vectorscopeMode: string
  vectorscopeMultiband: boolean
}

export interface ScopePopoutSpectrogramChunk extends ScopePopoutChunkBase {
  scope: 'spectrogram'
  monoChunks: Float32Array[]
  fftSize: number
  spectrogramScrollSpeed: number
  spectrogramClarityMode: SpectrogramClarityMode
  spectrogramScaleMode: SpectrogramScaleMode
  spectrogramTiltDbPerOctave: number
  spectrogramContrast: number
  spectrogramOrientation: SpectrogramOrientation
}

export interface ScopePopoutVUMeterChunk extends ScopePopoutChunkBase {
  scope: 'vumeter'
  channelChunks: MultichannelAudioChunk[]
  vuMeterMode: VUMeterMode
  vuMeterOrientation: VUMeterOrientation
}

export interface ScopePopoutLUFSMeterChunk extends ScopePopoutChunkBase {
  scope: 'lufsmeter'
  stereoChunks: Array<{
    left: Float32Array
    right: Float32Array
  }>
  lufsMeterMode: LUFSMeterMode
}

export interface ScopePopoutWaveformChunk extends ScopePopoutChunkBase {
  scope: 'waveform'
  monoChunks: Float32Array[]
  waveformScrollSpeed: number
  waveformGainDb: number
  waveformMultiband: boolean
}

export type ScopePopoutChunk =
  | ScopePopoutSpectrumChunk
  | ScopePopoutOscilloscopeChunk
  | ScopePopoutVectorscopeChunk
  | ScopePopoutSpectrogramChunk
  | ScopePopoutVUMeterChunk
  | ScopePopoutLUFSMeterChunk
  | ScopePopoutWaveformChunk
