export type ScopeKind = 'spectrum' | 'oscilloscope' | 'vectorscope'

export const SCOPE_KINDS: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope']

export interface ScopePopoutState {
  spectrum: boolean
  oscilloscope: boolean
  vectorscope: boolean
}

export const DEFAULT_SCOPE_POPOUT_STATE: ScopePopoutState = {
  spectrum: false,
  oscilloscope: false,
  vectorscope: false,
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'spectrum' || value === 'oscilloscope' || value === 'vectorscope'
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
}

export type ScopePopoutChunk =
  | ScopePopoutSpectrumChunk
  | ScopePopoutOscilloscopeChunk
  | ScopePopoutVectorscopeChunk
