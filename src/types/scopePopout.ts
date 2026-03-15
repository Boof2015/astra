import type { SpectrogramClarityMode, SpectrogramScaleMode } from './spectrogram'

export type ScopeKind = 'spectrum' | 'oscilloscope' | 'vectorscope' | 'spectrogram'

export const SCOPE_KINDS: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope', 'spectrogram']

export interface ScopePopoutState {
  spectrum: boolean
  oscilloscope: boolean
  vectorscope: boolean
  spectrogram: boolean
}

export const DEFAULT_SCOPE_POPOUT_STATE: ScopePopoutState = {
  spectrum: false,
  oscilloscope: false,
  vectorscope: false,
  spectrogram: false,
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'spectrum' || value === 'oscilloscope' || value === 'vectorscope' || value === 'spectrogram'
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
}

export type ScopePopoutChunk =
  | ScopePopoutSpectrumChunk
  | ScopePopoutOscilloscopeChunk
  | ScopePopoutVectorscopeChunk
  | ScopePopoutSpectrogramChunk
