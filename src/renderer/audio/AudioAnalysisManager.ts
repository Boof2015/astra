import type { AudioAnalysisFrame } from './AudioBackendEngine'
import { backendManager } from './AudioBackendManager'
import { isNativeAvailable, spectrum as nativeSpectrum } from './native'

const DEFAULT_MIN_DB = -90
const DEFAULT_MAX_DB = -10
const DEFAULT_FFT_SIZE = 2048
const DEFAULT_SMOOTHING = 0.9
const NATIVE_FRAME_CACHE_MS = 12

function mergeChunks(chunks: Float32Array[]): Float32Array | null {
  if (chunks.length === 0) return null
  if (chunks.length === 1) return chunks[0] ?? null

  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.length
  }

  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

export class AudioAnalysisManager {
  private lastFrame: AudioAnalysisFrame | null = null
  private lastSampleRate = 0
  private nativeConfigured = false
  private lastNativeCaptureAt = 0

  getEqSpectrumFrame(): AudioAnalysisFrame | null {
    if (backendManager.family === 'web') {
      return this.captureWebFrame()
    }
    return this.captureNativeFrame()
  }

  private captureWebFrame(): AudioAnalysisFrame | null {
    const analyser = backendManager.getEQAnalyserNode()
    if (!analyser || backendManager.playbackState !== 'playing') {
      return this.lastFrame
    }

    const bins = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(bins)
    this.lastFrame = {
      bins,
      sampleRate: backendManager.getSampleRate(),
      minDb: analyser.minDecibels,
      maxDb: analyser.maxDecibels,
      capturedAt: Date.now()
    }
    return this.lastFrame
  }

  private captureNativeFrame(): AudioAnalysisFrame | null {
    if (!isNativeAvailable()) {
      return this.lastFrame
    }

    if (backendManager.playbackState !== 'playing') {
      return this.lastFrame
    }

    const sampleRate = Math.max(1, backendManager.getSampleRate())
    if (!this.nativeConfigured || sampleRate !== this.lastSampleRate) {
      nativeSpectrum.setFFTSize(DEFAULT_FFT_SIZE)
      nativeSpectrum.setSampleRate(sampleRate)
      nativeSpectrum.setSmoothing(DEFAULT_SMOOTHING)
      this.nativeConfigured = true
      this.lastSampleRate = sampleRate
    }

    const now = performance.now()
    if (
      this.lastFrame
      && this.lastFrame.sampleRate === sampleRate
      && (now - this.lastNativeCaptureAt) < NATIVE_FRAME_CACHE_MS
    ) {
      return this.lastFrame
    }

    const chunks = backendManager.flushPendingPostEqSpectrumSamples()
    const mono = mergeChunks(chunks)
    if (!mono || mono.length === 0) {
      return this.lastFrame
    }

    const bins = nativeSpectrum.process(mono)
    if (!bins || bins.length === 0) {
      return this.lastFrame
    }

    this.lastNativeCaptureAt = now
    this.lastFrame = {
      bins,
      sampleRate,
      minDb: DEFAULT_MIN_DB,
      maxDb: DEFAULT_MAX_DB,
      capturedAt: Date.now()
    }
    return this.lastFrame
  }
}

export const audioAnalysisManager = new AudioAnalysisManager()
