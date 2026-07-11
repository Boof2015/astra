/**
 * Extract high-resolution waveform data from an AudioBuffer.
 * Returns a normalized Float32Array that the renderer downsamples
 * adaptively based on the display width.
 */
// Beyond a few thousand sampled frames per bin the binned RMS no longer
// changes visibly, so long tracks are stride-sampled instead of reading
// every frame.
const MAX_SAMPLED_FRAMES_PER_BIN = 4096

export function extractWaveformPeaks(buffer: AudioBuffer, resolution: number = 512): Float32Array {
  const length = buffer.length
  const channelCount = buffer.numberOfChannels
  const samplesPerBin = Math.floor(length / resolution)
  const stride = Math.max(1, Math.floor(samplesPerBin / MAX_SAMPLED_FRAMES_PER_BIN))
  const peaks = new Float32Array(resolution)

  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) {
    channels.push(buffer.getChannelData(c))
  }

  // RMS per bin — captures energy, not transient spikes
  let globalMax = 0
  for (let i = 0; i < resolution; i++) {
    const start = i * samplesPerBin
    const end = Math.min(start + samplesPerBin, length)
    let sumSquares = 0
    let count = 0

    for (let c = 0; c < channelCount; c++) {
      const data = channels[c]
      for (let s = start; s < end; s += stride) {
        sumSquares += data[s] * data[s]
        count++
      }
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, count))
    peaks[i] = rms
    if (rms > globalMax) globalMax = rms
  }

  // Normalize to [0, 1]
  if (globalMax > 0) {
    for (let i = 0; i < resolution; i++) {
      peaks[i] /= globalMax
    }
  }

  return peaks
}

/**
 * Downsample high-resolution waveform data to a target bar count,
 * with power curve and smoothing applied. Called at render time
 * so bar count adapts to the display width.
 */
export function downsampleWaveform(source: Float32Array, barCount: number): Float32Array {
  const sourceLen = source.length
  const binsPerBar = sourceLen / barCount
  const peaks = new Float32Array(barCount)

  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * binsPerBar)
    const end = Math.floor((i + 1) * binsPerBar)
    let sum = 0
    for (let j = start; j < end; j++) {
      sum += source[j]
    }
    peaks[i] = sum / (end - start)
  }

  // Re-normalize after averaging
  let max = 0
  for (let i = 0; i < barCount; i++) {
    if (peaks[i] > max) max = peaks[i]
  }
  if (max > 0) {
    for (let i = 0; i < barCount; i++) {
      peaks[i] /= max
    }
  }

  // Power curve — exaggerate dynamic range
  for (let i = 0; i < barCount; i++) {
    peaks[i] = Math.pow(peaks[i], 2.0)
  }

  // 2 smoothing passes
  let current = peaks
  for (let p = 0; p < 2; p++) {
    const smoothed = new Float32Array(current.length)
    smoothed[0] = current[0]
    smoothed[current.length - 1] = current[current.length - 1]
    for (let i = 1; i < current.length - 1; i++) {
      smoothed[i] = current[i - 1] * 0.25 + current[i] * 0.5 + current[i + 1] * 0.25
    }
    current = smoothed
  }

  return current
}

export class ProgressiveWaveformAccumulator {
  private readonly resolution: number
  private readonly totalFrames: number
  private readonly sumSquares: Float64Array
  private readonly counts: Uint32Array

  constructor(durationSeconds: number, sampleRate: number, resolution: number = 512) {
    const normalizedDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 1
    const normalizedSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000
    this.resolution = Math.max(8, Math.floor(resolution))
    this.totalFrames = Math.max(1, Math.floor(normalizedDuration * normalizedSampleRate))
    this.sumSquares = new Float64Array(this.resolution)
    this.counts = new Uint32Array(this.resolution)
  }

  ingestChunk(channelData: Float32Array[], startFrame: number): void {
    if (!Array.isArray(channelData) || channelData.length === 0) return
    const frameCount = channelData.reduce((min, channel) => (
      min === null ? channel.length : Math.min(min, channel.length)
    ), null as number | null)
    if (frameCount == null || frameCount <= 0) return

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const absoluteFrame = startFrame + frameIndex
      if (absoluteFrame < 0) continue
      const binIndex = Math.max(
        0,
        Math.min(this.resolution - 1, Math.floor((absoluteFrame / this.totalFrames) * this.resolution))
      )

      let frameSquareSum = 0
      for (let channelIndex = 0; channelIndex < channelData.length; channelIndex++) {
        const sample = channelData[channelIndex][frameIndex] ?? 0
        frameSquareSum += sample * sample
      }

      this.sumSquares[binIndex] += frameSquareSum / channelData.length
      this.counts[binIndex] += 1
    }
  }

  ingestInterleavedChunk(
    interleaved: Float32Array,
    channelCount: number,
    frameCount: number,
    startFrame: number,
    options: { maxSamples?: number } = {}
  ): void {
    const normalizedChannelCount = Math.max(1, Math.floor(channelCount))
    const normalizedFrameCount = Math.max(
      0,
      Math.min(Math.floor(frameCount), Math.floor(interleaved.length / normalizedChannelCount))
    )
    if (normalizedFrameCount <= 0) return

    const maxSamples = Number.isFinite(options.maxSamples)
      ? Math.max(1, Math.floor(Number(options.maxSamples)))
      : normalizedFrameCount
    const stride = Math.max(1, Math.ceil(normalizedFrameCount / maxSamples))

    for (let frameIndex = 0; frameIndex < normalizedFrameCount; frameIndex += stride) {
      const absoluteFrame = startFrame + frameIndex
      if (absoluteFrame < 0) continue

      const binIndex = Math.max(
        0,
        Math.min(this.resolution - 1, Math.floor((absoluteFrame / this.totalFrames) * this.resolution))
      )
      let frameSquareSum = 0
      const baseIndex = frameIndex * normalizedChannelCount
      for (let channelIndex = 0; channelIndex < normalizedChannelCount; channelIndex++) {
        const sample = interleaved[baseIndex + channelIndex] ?? 0
        frameSquareSum += sample * sample
      }

      const weight = Math.min(stride, normalizedFrameCount - frameIndex)
      this.sumSquares[binIndex] += (frameSquareSum / normalizedChannelCount) * weight
      this.counts[binIndex] += weight
    }
  }

  getPeaks(): Float32Array {
    const peaks = new Float32Array(this.resolution)
    let maxValue = 0

    for (let index = 0; index < this.resolution; index++) {
      const count = this.counts[index]
      if (count === 0) continue
      const rms = Math.sqrt(this.sumSquares[index] / count)
      peaks[index] = rms
      if (rms > maxValue) {
        maxValue = rms
      }
    }

    if (maxValue > 0) {
      for (let index = 0; index < this.resolution; index++) {
        peaks[index] /= maxValue
      }
    }

    return peaks
  }
}
