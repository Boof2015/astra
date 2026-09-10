import { OSCILLOSCOPE_VISUAL_GAIN } from '../../audio/native/oscilloscopeDisplaySamples'

export const NOTCH_SCOPE_WARMUP_SAMPLES = 4096
export const NOTCH_SPECTRUM_FFT_SIZE = 4096

export function notchOscilloscopeY(sample: number, height: number, gain = OSCILLOSCOPE_VISUAL_GAIN): number {
  return (1 - sample * gain) * height / 2
}

export function notchOscilloscopeGain(samples: Float32Array, previous: number, elapsedMs: number): number {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  const target = Math.min(OSCILLOSCOPE_VISUAL_GAIN, peak > 0 ? 0.9 / peak : OSCILLOSCOPE_VISUAL_GAIN)
  // Keep the usual Astra gain until it would clip. Make room immediately for
  // large peaks, then recover gently so the tiny trace does not pump in size.
  return target < previous ? target : previous + (target - previous) * -Math.expm1(-elapsedMs / 300)
}

function interpolatedDb(data: Float32Array, bin: number): number {
  const index = Math.max(0, Math.min(data.length - 1, bin))
  const low = Math.floor(index), high = Math.min(data.length - 1, low + 1)
  const a = Number.isFinite(data[low]) ? data[low] : -120
  const b = Number.isFinite(data[high]) ? data[high] : -120
  return a + (b - a) * (index - low)
}

export function fillNotchSpectrum(data: Float32Array, sampleRate: number, output: Float32Array): void {
  if (data.length < 2 || sampleRate <= 0) { output.fill(0); return }
  const minimum = 20, maximum = Math.min(20000, sampleRate / 2)
  const binWidth = sampleRate / (2 * data.length)
  const frequencyAt = (t: number) => minimum * Math.pow(maximum / minimum, t)
  const last = Math.max(1, output.length - 1)
  for (let i = 0; i < output.length; i++) {
    const frequency = frequencyAt(i / last)
    const from = frequencyAt(Math.max(0, (i - 0.5) / last)) / binWidth
    const to = frequencyAt(Math.min(1, (i + 0.5) / last)) / binWidth
    let db = interpolatedDb(data, frequency / binWidth)
    // Interpolate where pixels share a bin; preserve narrow peaks where a pixel
    // covers multiple bins instead of dropping everything between two samples.
    for (let bin = Math.ceil(from); bin <= Math.floor(to) && bin < data.length; bin++) {
      if (Number.isFinite(data[bin])) db = Math.max(db, data[bin])
    }
    output[i] = Math.max(0, Math.min(1, (db + 90) / 80))
  }
}

export function smoothNotchSpectrum(displayed: Float32Array, target: Float32Array, elapsedMs: number): boolean {
  let moving = false
  for (let i = 0; i < displayed.length; i++) {
    const difference = target[i] - displayed[i]
    if (Math.abs(difference) < 0.0001) { displayed[i] = target[i]; continue }
    // Fast response to transients, slower release; independent of chunk size,
    // IPC batching, and whether the display refreshes at 60 or 120 Hz.
    const timeConstant = difference > 0 ? 45 : 170
    displayed[i] += difference * -Math.expm1(-Math.max(0, elapsedMs) / timeConstant)
    moving = true
  }
  return moving
}
