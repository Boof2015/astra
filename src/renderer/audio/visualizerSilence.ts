import type { MultichannelAudioChunk } from '../../types/audioAnalysis'

export const DEFAULT_ANALYZER_SILENCE_SAMPLE_RATE = 48000
export const DEFAULT_ANALYZER_SILENCE_CHANNELS = 2
export const ANALYZER_SILENCE_FRAME_RATE = 60
export const MAX_ANALYZER_SILENCE_FRAME_MS = 1000 / 15
export const MIN_ANALYZER_SILENCE_SAMPLES = 128
export const MAX_ANALYZER_SILENCE_SAMPLES = 32768

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.round(value))
}

export function resolveAnalyzerSilenceSampleCount(sampleRate: number, minimumSamples = MIN_ANALYZER_SILENCE_SAMPLES): number {
  const safeSampleRate = normalizePositiveInteger(sampleRate, DEFAULT_ANALYZER_SILENCE_SAMPLE_RATE)
  const safeMinimum = normalizePositiveInteger(minimumSamples, MIN_ANALYZER_SILENCE_SAMPLES)
  const frameSamples = Math.round(safeSampleRate / ANALYZER_SILENCE_FRAME_RATE)
  return Math.min(MAX_ANALYZER_SILENCE_SAMPLES, Math.max(MIN_ANALYZER_SILENCE_SAMPLES, safeMinimum, frameSamples))
}

export function clampAnalyzerSilenceSampleCount(sampleCount: number): number {
  return Math.min(MAX_ANALYZER_SILENCE_SAMPLES, Math.max(1, normalizePositiveInteger(sampleCount, MIN_ANALYZER_SILENCE_SAMPLES)))
}

export function createMonoSilenceChunk(sampleRate: number, minimumSamples?: number): Float32Array {
  return new Float32Array(resolveAnalyzerSilenceSampleCount(sampleRate, minimumSamples))
}

export function createMonoSilenceChunkWithSampleCount(sampleCount: number): Float32Array {
  return new Float32Array(clampAnalyzerSilenceSampleCount(sampleCount))
}

export function createStereoSilenceChunk(
  sampleRate: number,
  minimumSamples?: number
): { left: Float32Array; right: Float32Array } {
  const sampleCount = resolveAnalyzerSilenceSampleCount(sampleRate, minimumSamples)
  return {
    left: new Float32Array(sampleCount),
    right: new Float32Array(sampleCount),
  }
}

export function createMultichannelSilenceChunk(
  sampleRate: number,
  channelCount = DEFAULT_ANALYZER_SILENCE_CHANNELS,
  minimumSamples?: number
): MultichannelAudioChunk {
  const sampleCount = resolveAnalyzerSilenceSampleCount(sampleRate, minimumSamples)
  const normalizedChannelCount = Math.max(1, normalizePositiveInteger(channelCount, DEFAULT_ANALYZER_SILENCE_CHANNELS))
  return {
    channels: Array.from({ length: normalizedChannelCount }, () => new Float32Array(sampleCount)),
  }
}

export function isPlaybackAnalyzerActive(playbackState: string): boolean {
  return playbackState === 'playing' || playbackState === 'paused'
}

export class AnalyzerSilenceClock {
  private lastTimestampMs: number | null = null

  reset(): void {
    this.lastTimestampMs = null
  }

  nextSampleCount(sampleRate: number, nowMs = getNowMs()): number {
    const safeSampleRate = normalizePositiveInteger(sampleRate, DEFAULT_ANALYZER_SILENCE_SAMPLE_RATE)
    const fallbackFrameMs = 1000 / ANALYZER_SILENCE_FRAME_RATE
    const elapsedMs = this.lastTimestampMs === null
      ? fallbackFrameMs
      : nowMs - this.lastTimestampMs
    this.lastTimestampMs = nowMs

    const safeElapsedMs = Number.isFinite(elapsedMs) && elapsedMs > 0
      ? Math.min(elapsedMs, MAX_ANALYZER_SILENCE_FRAME_MS)
      : fallbackFrameMs

    return clampAnalyzerSilenceSampleCount(Math.round((safeSampleRate * safeElapsedMs) / 1000))
  }
}

function getNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}
