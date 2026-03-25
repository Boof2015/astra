import { audioEngine } from './AudioEngine'
import { usePlayerStore } from '../stores/playerStore'

type Listener = () => void

export interface EQAnalyzerFrameSnapshot {
  readonly data: Float32Array | null
  readonly sampleRate: number
  readonly minDecibels: number
  readonly maxDecibels: number
  readonly available: boolean
}

const listeners = new Set<Listener>()
let initialized = false
let frameId: number | null = null
let frameData: Float32Array<ArrayBufferLike> | null = null
let snapshot: EQAnalyzerFrameSnapshot = {
  data: null,
  sampleRate: 48000,
  minDecibels: -100,
  maxDecibels: 0,
  available: false,
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function stopLoop(): void {
  if (frameId !== null) {
    window.cancelAnimationFrame(frameId)
    frameId = null
  }
}

function setUnavailable(): void {
  if (!snapshot.available && snapshot.data === null) {
    return
  }

  snapshot = {
    data: null,
    sampleRate: audioEngine.getSampleRate(),
    minDecibels: snapshot.minDecibels,
    maxDecibels: snapshot.maxDecibels,
    available: false,
  }
  notifyListeners()
}

function captureFrame(): void {
  const analyser = audioEngine.getEQAnalyserNode()
  if (!analyser || usePlayerStore.getState().playbackState !== 'playing') {
    setUnavailable()
    return
  }

  const binCount = analyser.frequencyBinCount
  if (!frameData || frameData.length !== binCount) {
    frameData = new Float32Array(binCount)
  }

  analyser.getFloatFrequencyData(frameData as Float32Array<ArrayBuffer>)
  snapshot = {
    data: frameData,
    sampleRate: audioEngine.getSampleRate(),
    minDecibels: analyser.minDecibels,
    maxDecibels: analyser.maxDecibels,
    available: true,
  }
  notifyListeners()
}

function tick(): void {
  frameId = null
  if (listeners.size === 0 || usePlayerStore.getState().playbackState !== 'playing') {
    setUnavailable()
    return
  }

  captureFrame()
  frameId = window.requestAnimationFrame(tick)
}

function startLoop(): void {
  if (frameId !== null || listeners.size === 0 || usePlayerStore.getState().playbackState !== 'playing') {
    return
  }

  captureFrame()
  frameId = window.requestAnimationFrame(tick)
}

function ensureInitialized(): void {
  if (initialized) return
  initialized = true

  usePlayerStore.subscribe((state, prevState) => {
    if (state.playbackState === prevState.playbackState) return

    if (state.playbackState === 'playing') {
      startLoop()
      return
    }

    stopLoop()
    setUnavailable()
  })
}

export function getEQAnalyzerFrameSnapshot(): EQAnalyzerFrameSnapshot {
  ensureInitialized()
  return snapshot
}

export function subscribeToEQAnalyzerFrames(listener: Listener): () => void {
  ensureInitialized()
  listeners.add(listener)
  startLoop()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopLoop()
      setUnavailable()
    }
  }
}
