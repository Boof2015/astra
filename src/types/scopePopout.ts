import type { LUFSMeterMode } from './lufsmeter'
import type { SpectrogramClarityMode, SpectrogramScaleMode } from './spectrogram'
import type { VUMeterMode } from './vumeter'

export type ScopeKind = 'spectrum' | 'oscilloscope' | 'vectorscope' | 'spectrogram' | 'vumeter' | 'lufsmeter'

export const SCOPE_KINDS: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope', 'spectrogram', 'vumeter', 'lufsmeter']

export interface ScopePopoutState {
  spectrum: boolean
  oscilloscope: boolean
  vectorscope: boolean
  spectrogram: boolean
  vumeter: boolean
  lufsmeter: boolean
}

export const DEFAULT_SCOPE_POPOUT_STATE: ScopePopoutState = {
  spectrum: false,
  oscilloscope: false,
  vectorscope: false,
  spectrogram: false,
  vumeter: false,
  lufsmeter: false,
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'spectrum' || value === 'oscilloscope' || value === 'vectorscope' || value === 'spectrogram' || value === 'vumeter' || value === 'lufsmeter'
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

export interface ScopePopoutVUMeterChunk extends ScopePopoutChunkBase {
  scope: 'vumeter'
  stereoChunks: Array<{
    left: Float32Array
    right: Float32Array
  }>
  vuMeterMode: VUMeterMode
}

export interface ScopePopoutLUFSMeterChunk extends ScopePopoutChunkBase {
  scope: 'lufsmeter'
  stereoChunks: Array<{
    left: Float32Array
    right: Float32Array
  }>
  lufsMeterMode: LUFSMeterMode
}

export type ScopePopoutChunk =
  | ScopePopoutSpectrumChunk
  | ScopePopoutOscilloscopeChunk
  | ScopePopoutVectorscopeChunk
  | ScopePopoutSpectrogramChunk
  | ScopePopoutVUMeterChunk
  | ScopePopoutLUFSMeterChunk
