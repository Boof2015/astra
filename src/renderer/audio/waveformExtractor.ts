/**
 * Extract high-resolution waveform data from an AudioBuffer.
 * Returns a normalized Float32Array that the renderer downsamples
 * adaptively based on the display width.
 */
export function extractWaveformPeaks(buffer: AudioBuffer, resolution: number = 512): Float32Array {
  const length = buffer.length
  const channelCount = buffer.numberOfChannels
  const samplesPerBin = Math.floor(length / resolution)
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
      for (let s = start; s < end; s++) {
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

export function extractWaveformPeaksFromRaw(
  samples: Float32Array,
  channels: number,
  _sampleRate: number,
  resolution: number = 512
): Float32Array {
  if (!Number.isFinite(channels) || channels <= 0 || samples.length === 0) {
    return new Float32Array(resolution)
  }

  const frameCount = Math.max(1, Math.floor(samples.length / channels))
  const samplesPerBin = Math.max(1, Math.floor(frameCount / resolution))
  const peaks = new Float32Array(resolution)

  let globalMax = 0
  for (let i = 0; i < resolution; i++) {
    const startFrame = i * samplesPerBin
    const endFrame = Math.min(frameCount, startFrame + samplesPerBin)
    let sumSquares = 0
    let count = 0

    for (let frame = startFrame; frame < endFrame; frame++) {
      const baseIndex = frame * channels
      for (let channel = 0; channel < channels; channel++) {
        const sample = samples[baseIndex + channel] ?? 0
        sumSquares += sample * sample
        count += 1
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, count))
    peaks[i] = rms
    if (rms > globalMax) globalMax = rms
  }

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
