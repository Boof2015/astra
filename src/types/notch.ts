import type { MiniPlayerCommand, MiniPlayerSnapshot, MiniPlayerVisualizerMode, MiniPlayerVisualizerStreamChunk } from './miniPlayer'

export type NotchRestingView = 'hidden' | 'metadata' | 'oscilloscope' | 'spectrum'
export interface NotchPrefs {
  enabled: boolean
  restingView: NotchRestingView
  hoverEnabled: boolean
  trackChangePopups: boolean
  showOverFullscreen: boolean
}
export const DEFAULT_NOTCH_PREFS: NotchPrefs = {
  enabled: false, restingView: 'hidden', hoverEnabled: true,
  trackChangePopups: true, showOverFullscreen: true,
}
export const NOTCH_SIZE = { width: 440, height: 174, backingHeight: 224, previewHeight: 24 } as const
export interface NotchSurfaceBounds {
  x: number; y: number; width: number; height: number
  points: { x: number; y: number }[]
}
export interface NotchGeometry { displayId: number; x: number; y: number; width: number; height: number }
export interface NotchPointer {
  near: boolean
  proximity: number
  // Coordinates relative to the camera's lower-edge midpoint, y downward.
  x: number
  y: number
  edgeDistance: number
  // Only actual mouse movement may supply hover-intent evidence.
  motion: boolean
  withinHover: boolean
  inside: boolean
  down: boolean
  dragging: boolean
  onActiveSpace: boolean
}
export interface NotchPresentation {
  view: NotchRestingView | 'peek' | 'expanded'
  reason: 'resting' | 'proximity' | 'hover' | 'notification' | 'expanded'
}
export interface NotchRuntimeState extends NotchPresentation {
  prefs: NotchPrefs
  availability: 'available' | 'no-notch' | 'unsupported' | 'unavailable'
  error: string | null
  attached: boolean
  notchWidth: number | null
  notchHeight: number | null
  proximity: number
  visualizerMode: MiniPlayerVisualizerMode
}
export const EMPTY_NOTCH_STATE: NotchRuntimeState = {
  prefs: DEFAULT_NOTCH_PREFS, availability: 'unsupported', error: null,
  attached: false, notchWidth: null, notchHeight: null, proximity: 0, view: 'hidden', reason: 'resting', visualizerMode: 'off',
}
export interface NotchAPI {
  getState(): Promise<NotchRuntimeState>
  setPrefs(prefs: Partial<NotchPrefs>): Promise<NotchRuntimeState>
  onState(callback: (state: NotchRuntimeState) => void): () => void
  getSnapshot(): Promise<MiniPlayerSnapshot | null>
  onSnapshot(callback: (snapshot: MiniPlayerSnapshot) => void): () => void
  onVisualizerChunk(callback: (chunk: MiniPlayerVisualizerStreamChunk) => void): () => void
  sendCommand(command: MiniPlayerCommand): void
  expand(): void
  collapse(): void
  openAstra(): void
  ready(): void
  setSurface(bounds: NotchSurfaceBounds): void
  setReducedMotion(reduced: boolean): void
}
