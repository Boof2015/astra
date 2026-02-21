export const BASE_DISPLAY_SAMPLES = 2048
export const BASE_RATE_MIN = 44100
export const BASE_RATE_MAX = 48000
export const MIN_DISPLAY_SAMPLES = 64
export const MAX_DISPLAY_SAMPLES = 32767

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getNormalizedOscilloscopeDisplaySamples(sampleRate: number): number {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : BASE_RATE_MAX

  let samples = BASE_DISPLAY_SAMPLES

  if (safeSampleRate < BASE_RATE_MIN) {
    samples = Math.round(BASE_DISPLAY_SAMPLES * (safeSampleRate / BASE_RATE_MIN))
  } else if (safeSampleRate > BASE_RATE_MAX) {
    samples = Math.round(BASE_DISPLAY_SAMPLES * (safeSampleRate / BASE_RATE_MAX))
  }

  return clamp(samples, MIN_DISPLAY_SAMPLES, MAX_DISPLAY_SAMPLES)
}
